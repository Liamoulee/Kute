use crate::{debug_print, window};
use cef::*;
use std::{
    env,
    io::{Read, Write},
    os::{
        linux::net::SocketAddrExt,
        unix::net::{SocketAddr, UnixListener, UnixStream},
    },
    process,
    time::{Duration, Instant},
};

// abstract sockets are per network namespace, not per user
fn address() -> Option<SocketAddr> {
    let name = format!(
        "kute-instance-{}{}",
        unsafe { libc::getuid() },
        if crate::modules::bench::active() { "-bench" } else { "" }
    );
    SocketAddr::from_abstract_name(name.as_bytes()).ok()
}

wrap_task! {
    struct ArgsTask {
        args: String,
    }

    impl Task {
        fn execute(&self) {
            window::receive_args(&self.args);
        }
    }
}

// first instance listens, a second one hands its args over and exits. the socket dies with the process
pub fn register() {
    let Some(address) = address() else { return };
    match UnixListener::bind_addr(&address) {
        Ok(listener) => {
            std::thread::spawn(move || {
                for mut stream in listener.incoming().flatten() {
                    let mut args = String::new();
                    stream.set_read_timeout(Some(Duration::from_secs(2))).ok();
                    if stream.read_to_string(&mut args).is_ok() {
                        debug_print!("instance: args from another instance: {args}");
                        let mut task = ArgsTask::new(args);
                        post_task(ThreadId::UI, Some(&mut task));
                    }
                }
            });
        }
        Err(_) => {
            eprintln!("Instance already running");
            if let Ok(mut stream) = UnixStream::connect_addr(&address) {
                let args = env::args().skip(1).collect::<Vec<String>>().join(" ");
                stream.write_all(args.as_bytes()).ok();
            }
            process::exit(0);
        }
    }
}

// after restart() the old client still holds the socket and the profile
pub fn wait_for(pid: u32) {
    let started = Instant::now();
    while std::path::Path::new(&format!("/proc/{pid}")).exists() && started.elapsed() < Duration::from_secs(15) {
        std::thread::sleep(Duration::from_millis(50));
    }
}
