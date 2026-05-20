#[path = "../server.rs"]
mod server;

#[tokio::main]
async fn main() {
    if let Err(error) = server::run().await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
