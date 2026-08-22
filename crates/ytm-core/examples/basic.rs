use ytm_core::{KindsInput, YtmClient};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = YtmClient::new()?;
    let result = client.kinds(KindsInput::default()).await?;
    for kind in result.kinds {
        println!("{}\t{}", kind.code, kind.name);
    }
    Ok(())
}
