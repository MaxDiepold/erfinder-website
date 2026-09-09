#!/usr/bin/env python3
# ESP Phone Flasher V0.2 patch for:
# ulso/pico-io-bridge @ d6bf64f9d372f17fdc293f60eeb29d5152cb9d5c

from pathlib import Path
import sys

if len(sys.argv) != 3:
    raise SystemExit("usage: patch_upstream.py <upstream-dir> <esp-flasher.html>")

up = Path(sys.argv[1])
web_source = Path(sys.argv[2])


def replace_once(path: Path, old: str, new: str):
    text = path.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(
            f"{path}: expected exactly one match, got {count}: {old[:100]!r}"
        )
    path.write_text(text.replace(old, new, 1))


# Deterministic address: device 192.168.7.1, iPhone lease 192.168.7.2.
network = up / "src/network.rs"
replace_once(
    network,
    "    ([10, subnet_x, subnet_y, 1], [10, subnet_x, subnet_y, 2])",
    "    ([192, 168, 7, 1], [192, 168, 7, 2])",
)

usb = up / "src/usb_host.rs"

# Reuse the existing cross-core CDC bridge, but expose it to HTTP/WebSocket.
bridge_marker = '''#[embassy_executor::task]
pub(crate) async fn usb_serial_task(stack: Stack<'static>) {'''

bridge_helpers = '''pub(crate) async fn web_bridge_open() -> Result<u32, Error> {
    BRIDGE_TO_USB.clear();
    USB_TO_BRIDGE.clear();
    BRIDGE_EVENT.reset();
    BRIDGE_OUT_ACK.reset();
    bridge_open().await
}

pub(crate) async fn web_bridge_write(session: u32, bytes: &[u8]) -> Result<(), Error> {
    if bytes.is_empty() {
        return Ok(());
    }

    for chunk in bytes.chunks(CDC_MAX_TRANSFER) {
        if !status().await.bridge_connected {
            return Err(Error::NotReady);
        }

        let mut data = CdcData::empty();
        data.bytes[..chunk.len()].copy_from_slice(chunk);
        data.len = chunk.len() as u8;
        BRIDGE_TO_USB.send(BridgeFrame { session, data }).await;

        loop {
            match select(
                BRIDGE_OUT_ACK.wait(),
                Timer::after(Duration::from_secs(2))
            ).await {
                Either::First(ack_session) if ack_session == session => break,
                Either::First(_) => continue,
                Either::Second(()) => return Err(Error::Timeout),
            }
        }
    }
    Ok(())
}

pub(crate) async fn web_bridge_read(session: u32) -> Result<CdcData, Error> {
    loop {
        match select(
            USB_TO_BRIDGE.receive(),
            Timer::after(Duration::from_millis(500)),
        ).await {
            Either::First(frame) if frame.session == session => return Ok(frame.data),
            Either::First(_) => continue,
            Either::Second(()) => {
                if !status().await.bridge_connected {
                    return Err(Error::NotReady);
                }
            }
        }
    }
}

pub(crate) async fn web_bridge_close(session: u32) {
    BRIDGE_TO_USB.clear();
    USB_TO_BRIDGE.clear();
    let _ = bridge_close(session).await;
    BRIDGE_TO_USB.clear();
    USB_TO_BRIDGE.clear();
}

#[embassy_executor::task]
pub(crate) async fn usb_serial_task(stack: Stack<'static>) {'''

replace_once(usb, bridge_marker, bridge_helpers)

# Existing WebSocket parser marks binary frames but discards their payload.
ws = up / "src/websocket.rs"
replace_once(ws, "    Binary,\n", "    Binary(&'a [u8]),\n")
replace_once(
    ws,
    "        0x2 => Some(Frame::Binary),",
    "        0x2 => Some(Frame::Binary(payload)),",
)

http = up / "src/http.rs"

# Existing endpoints do not use binary payloads.
http.write_text(http.read_text().replace("Frame::Binary =>", "Frame::Binary(_) =>"))

replace_once(
    http,
    '''enum WebSocketEndpoint {
    #[cfg(feature = "pio-usb-host")]
    Audio,''',
    '''enum WebSocketEndpoint {
    #[cfg(feature = "pio-usb-host")]
    Serial,
    #[cfg(feature = "pio-usb-host")]
    Audio,''',
)

replace_once(
    http,
    '''fn websocket_endpoint(request: &str) -> Option<WebSocketEndpoint> {
    #[cfg(feature = "pio-usb-host")]
    if request.starts_with("GET /audio ") {''',
    '''fn websocket_endpoint(request: &str) -> Option<WebSocketEndpoint> {
    #[cfg(feature = "pio-usb-host")]
    if request.starts_with("GET /serial ") {
        return Some(WebSocketEndpoint::Serial);
    }

    #[cfg(feature = "pio-usb-host")]
    if request.starts_with("GET /audio ") {''',
)

serial_loop = r'''
#[cfg(feature = "pio-usb-host")]
async fn serial_websocket_loop(
    socket: &mut TcpSocket<'_>,
    buf: &mut [u8],
) -> Result<(), embassy_net::tcp::Error> {
    const READY: &[u8] =
        b"{\"type\":\"serial.ready\",\"ok\":true,\"endpoint\":\"/serial\"}";
    const BUSY: &[u8] =
        b"{\"type\":\"serial.error\",\"ok\":false,\"message\":\"ESP USB CDC unavailable or busy\"}";

    let session = match crate::usb_host::web_bridge_open().await {
        Ok(session) => session,
        Err(_) => {
            websocket::send_text(socket, BUSY).await?;
            websocket::send_close(socket).await?;
            return Ok(());
        }
    };

    let result = async {
        websocket::send_text(socket, READY).await?;

        loop {
            if !socket.may_recv() {
                return Ok(());
            }

            match select(
                socket.wait_read_ready(),
                crate::usb_host::web_bridge_read(session),
            ).await {
                Either::First(()) => {
                    let Some(frame) = websocket::read_frame(socket, buf).await? else {
                        return Ok(());
                    };

                    match frame {
                        Frame::Close => {
                            websocket::send_close(socket).await?;
                            return Ok(());
                        }
                        Frame::Ping(payload) => websocket::send_pong(socket, payload).await?,
                        Frame::Pong => {}
                        Frame::Text(payload) => {
                            if payload == b"ping" {
                                websocket::send_text(socket, b"pong").await?;
                            }
                        }
                        Frame::Binary(payload) => {
                            if crate::usb_host::web_bridge_write(session, payload)
                                .await
                                .is_err()
                            {
                                websocket::send_text(
                                    socket,
                                    b"{\"type\":\"serial.error\",\"ok\":false,\"message\":\"USB write failed\"}",
                                ).await?;
                                return Ok(());
                            }
                        }
                    }
                }
                Either::Second(Ok(data)) => {
                    websocket::send_binary(socket, data.as_bytes()).await?;
                }
                Either::Second(Err(_)) => {
                    websocket::send_text(
                        socket,
                        b"{\"type\":\"serial.error\",\"ok\":false,\"message\":\"ESP USB disconnected\"}",
                    ).await?;
                    return Ok(());
                }
            }
        }
    }.await;

    crate::usb_host::web_bridge_close(session).await;
    result
}

'''

audio_marker = '''#[cfg(feature = "pio-usb-host")]
async fn audio_websocket_loop('''
replace_once(http, audio_marker, serial_loop + audio_marker)

replace_once(
    http,
    '''            match endpoint {
                #[cfg(feature = "pio-usb-host")]
                WebSocketEndpoint::Audio => audio_websocket_loop(socket, rx_buf).await?,''',
    '''            match endpoint {
                #[cfg(feature = "pio-usb-host")]
                WebSocketEndpoint::Serial => serial_websocket_loop(socket, rx_buf).await?,
                #[cfg(feature = "pio-usb-host")]
                WebSocketEndpoint::Audio => audio_websocket_loop(socket, rx_buf).await?,''',
)

# Dedicated flasher page.
route_marker = '''    } else if request.starts_with("GET /api/usb-host/status ") {'''
page_route = r'''    } else if request.starts_with("GET /esp-flasher.html ") {
        #[cfg(feature = "pio-usb-host")]
        {
            const BODY: &[u8] = include_bytes!("esp_flasher.html");
            write_http_response(socket, "text/html", BODY).await?;
        }
        #[cfg(not(feature = "pio-usb-host"))]
        {
            write_not_found(socket).await?;
        }
'''
replace_once(http, route_marker, page_route + route_marker)

# Make the flasher the root page as well.
root_marker = '''    } else if request.starts_with("GET /favicon.ico ") {'''
root_route = r'''    } else if request.starts_with("GET / ")
        || request.starts_with("GET /index.html ")
    {
        const BODY: &[u8] = include_bytes!("esp_flasher.html");
        write_http_response(socket, "text/html", BODY).await?;
'''
replace_once(http, root_marker, root_route + root_marker)

(up / "src/esp_flasher.html").write_bytes(web_source.read_bytes())

print("ESP Phone Flasher V0.2 patch applied")
print("Board: Adafruit Feather RP2040 USB Host")
print("Device IP: 192.168.7.1")
print("UI: / and /esp-flasher.html")
print("Binary CDC WebSocket: /serial")
