use std::sync::{Arc, Mutex};

use cef::{
    rc::*,
    wrapper::byte_read_handler::{ByteReadHandler, ByteStream},
    *,
};

wrap_resource_handler! {
    pub struct KuteResourceHandler {
        mime_type: String,
        stream: Option<StreamReader>,
    }

    impl ResourceHandler {
        fn open(
            &self,
            _request: Option<&mut Request>,
            handle_request: Option<&mut i32>,
            _callback: Option<&mut Callback>,
        ) -> i32 {
            // answer straight away, the bytes are already in memory
            if let Some(handle_request) = handle_request {
                *handle_request = 1;
            }
            1
        }

        fn response_headers(
            &self,
            response: Option<&mut Response>,
            response_length: Option<&mut i64>,
            _redirect_url: Option<&mut CefString>,
        ) {
            let Some(response) = response else { return };

            response.set_status(200);
            response.set_status_text(Some(&CefString::from("OK")));
            response.set_mime_type(Some(&CefString::from(self.mime_type.as_str())));
            // what this whole handler exists for. The real CDN answers with the same two, so a replaced file
            // behaves like the one it replaced, whichever origin it is served in place of
            response.set_header_by_name(Some(&CefString::from("Access-Control-Allow-Origin")), Some(&CefString::from("*")), 1);
            response.set_header_by_name(Some(&CefString::from("Cross-Origin-Resource-Policy")), Some(&CefString::from("cross-origin")), 1);

            if let Some(response_length) = response_length {
                *response_length = if self.stream.is_some() { -1 } else { 0 };
            }
        }

        #[allow(clippy::not_unsafe_ptr_arg_deref)]
        fn read(
            &self,
            data_out: *mut u8,
            bytes_to_read: i32,
            bytes_read: Option<&mut i32>,
            _callback: Option<&mut ResourceReadCallback>,
        ) -> i32 {
            if bytes_to_read < 1 {
                return 0;
            }
            let Some(bytes_read) = bytes_read else { return 0 };
            let Some(stream) = &self.stream else {
                *bytes_read = 0;
                return 1;
            };

            // until the buffer is full or the stream says it has nothing left
            *bytes_read = 0;
            loop {
                let data_out = unsafe { data_out.add(*bytes_read as usize) };
                let read = stream.read(data_out, 1, (bytes_to_read - *bytes_read) as usize);
                *bytes_read += read as i32;
                if read == 0 || *bytes_read >= bytes_to_read {
                    break;
                }
            }

            i32::from(*bytes_read > 0)
        }
    }
}

// A handler that answers one request with these bytes.
pub fn serve(mime_type: &str, bytes: Vec<u8>) -> Option<ResourceHandler> {
    let mut read_handler = ByteReadHandler::new(Arc::new(Mutex::new(ByteStream::new(bytes))));
    let stream = stream_reader_create_for_handler(Some(&mut read_handler))?;
    Some(KuteResourceHandler::new(mime_type.to_string(), Some(stream)))
}
