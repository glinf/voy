use crate::engine;
use anyhow::Context;
use serde::{Deserialize, Serialize};
use tsify::Tsify;

pub type NumberOfResult = usize;
pub type Query = Vec<f32>;
pub type SerializedIndex = Vec<u8>;

#[derive(Serialize, Deserialize, Debug, Clone, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct EmbeddedResource {
    pub id: String,
    pub title: String,
    pub url: String,
    pub embeddings: Vec<f32>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct Resource {
    pub embeddings: Vec<EmbeddedResource>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Tsify)]
#[tsify(into_wasm_abi)]
pub struct Neighbor {
    pub id: String,
    pub title: String,
    pub url: String,
    pub score: f32,
}

#[derive(Serialize, Deserialize, Debug, Clone, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct SearchResult {
    pub neighbors: Vec<Neighbor>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct VoyOptions {
    pub metric: Option<String>,
}

impl VoyOptions {
    pub fn metric(&self) -> anyhow::Result<engine::Metric> {
        parse_metric(self.metric.as_deref())
    }
}

pub fn parse_metric(metric: Option<&str>) -> anyhow::Result<engine::Metric> {
    match metric {
        None => Ok(engine::Metric::Euclidean),
        Some("euclidean") => Ok(engine::Metric::Euclidean),
        Some("cosine") => Ok(engine::Metric::Cosine),
        Some(other) => Err(anyhow::anyhow!("unsupported metric: {other}"))
            .with_context(|| "metric must be either \"euclidean\" or \"cosine\""),
    }
}
