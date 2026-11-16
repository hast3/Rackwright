use std::path::PathBuf;

#[tokio::main]
async fn main() {
    let data = PathBuf::from(std::env::var("RW_DATA").unwrap_or_else(|_| "./data".into()));
    let host = std::env::var("RW_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port = std::env::var("RW_PORT").unwrap_or_else(|_| "8080".into());
    let static_dir = PathBuf::from(std::env::var("RW_STATIC").unwrap_or_else(|_| "./web/dist".into()));

    let app = match rackwright_server::build_app(&data, &static_dir) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("rackwright-server: {e}");
            std::process::exit(1);
        }
    };

    let addr = format!("{host}:{port}");
    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("rackwright-server: cannot listen on {addr}: {e}");
            std::process::exit(1);
        }
    };
    println!(
        "rackwright-server listening on http://{addr} (data: {}, static: {})",
        data.display(),
        static_dir.display()
    );
    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("rackwright-server: {e}");
        std::process::exit(1);
    }
}
