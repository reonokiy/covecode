fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios") {
        println!("cargo::rerun-if-changed=src/bonjour.c");
        cc::Build::new()
            .file("src/bonjour.c")
            .compile("cove_bonjour");
        println!("cargo::rustc-link-lib=dns_sd");
    }
}
