use super::{Error, Tunnel, open};
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex, OnceLock},
};
use tokio::runtime::Runtime;

// The opaque capability URL is also the handle for releasing this listener.
static TUNNELS: LazyLock<Mutex<HashMap<String, Tunnel>>> = LazyLock::new(Mutex::default);
static RUNTIME: OnceLock<std::io::Result<Runtime>> = OnceLock::new();

fn start(json: &str) -> Result<String, Error> {
    let runtime = RUNTIME
        .get_or_init(|| {
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .worker_threads(2)
                .build()
        })
        .as_ref()
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    let endpoint = serde_json::from_str(json)?;
    let tunnel = runtime.block_on(open(endpoint))?;
    let url = tunnel.base_url.clone();
    TUNNELS
        .lock()
        .map_err(|_| "tunnel registry unavailable")?
        .insert(url.clone(), tunnel);
    Ok(url)
}

fn stop(url: &str) {
    if let Ok(mut tunnels) = TUNNELS.lock() {
        tunnels.remove(url);
    }
}

#[cfg(not(target_os = "android"))]
mod c {
    use super::*;
    use std::ffi::{CStr, CString, c_char};

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn cove_tunnel_open(json: *const c_char) -> *mut c_char {
        if json.is_null() {
            return std::ptr::null_mut();
        }
        let result = unsafe { CStr::from_ptr(json) }
            .to_str()
            .ok()
            .and_then(|s| start(s).ok());
        result
            .and_then(|s| CString::new(s).ok())
            .map_or(std::ptr::null_mut(), CString::into_raw)
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn cove_tunnel_close(url: *const c_char) {
        if !url.is_null()
            && let Ok(s) = unsafe { CStr::from_ptr(url) }.to_str()
        {
            stop(s);
        }
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn cove_tunnel_free(url: *mut c_char) {
        if !url.is_null() {
            drop(unsafe { CString::from_raw(url) });
        }
    }
}

#[cfg(target_os = "android")]
mod android {
    use super::*;
    use jni::{
        JNIEnv,
        objects::{GlobalRef, JClass, JObject, JString},
        sys::jstring,
    };
    static APPLICATION: OnceLock<GlobalRef> = OnceLock::new();

    #[unsafe(no_mangle)]
    pub extern "system" fn Java_expo_modules_covep2p_NativeTunnel_open(
        mut env: JNIEnv,
        _: JClass,
        app: JObject,
        input: JString,
    ) -> jstring {
        let result = (|| -> Result<_, Error> {
            let vm = env.get_java_vm()?;
            let ctx = env.new_global_ref(app)?;
            APPLICATION.get_or_init(|| {
                // The library owns one process-lifetime application reference for the system DNS resolver.
                unsafe {
                    ndk_context::initialize_android_context(
                        vm.get_java_vm_pointer().cast(),
                        ctx.as_obj().as_raw().cast(),
                    )
                };
                ctx
            });
            let json: String = env.get_string(&input)?.into();
            Ok(env.new_string(start(&json)?)?.into_raw())
        })();
        result.unwrap_or_else(|_| {
            let _ = env.throw_new(
                "java/io/IOException",
                "Could not open the encrypted environment tunnel",
            );
            std::ptr::null_mut()
        })
    }

    #[unsafe(no_mangle)]
    pub extern "system" fn Java_expo_modules_covep2p_NativeTunnel_close(
        mut env: JNIEnv,
        _: JClass,
        input: JString,
    ) {
        if let Ok(s) = env.get_string(&input) {
            stop(&String::from(s));
        }
    }
}
