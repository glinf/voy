use crate::{
    Neighbor, NumberOfResult, Query, Resource, SearchResult, SerializedIndex, VoyOptions, engine,
    utils::set_panic_hook,
};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn multi_shard_search(
    shard_buffers: js_sys::Array,
    query: Query,
    k: NumberOfResult,
) -> Result<SearchResult, JsError> {
    set_panic_hook();

    if shard_buffers.length() == 0 || k == 0 {
        return Ok(SearchResult {
            neighbors: vec![],
        });
    }

    let mut all_hits = Vec::new();
    let mut metric = None;

    for i in 0..shard_buffers.length() {
        let buffer = js_sys::Uint8Array::new(&shard_buffers.get(i)).to_vec();
        let index =
            engine::deserialize(&buffer).map_err(|error| JsError::new(&error.to_string()))?;

        if let Some(m) = metric {
            if m != index.metric {
                return Err(JsError::new("all shards must use the same metric"));
            }
        }
        metric = Some(index.metric);

        let hits =
            engine::search(&index, &query, k).map_err(|error| JsError::new(&error.to_string()))?;
        all_hits.extend(hits);
    }

    let metric = metric.unwrap();
    all_hits.sort_by(|a, b| match metric {
        engine::Metric::Euclidean => a
            .score
            .partial_cmp(&b.score)
            .unwrap_or(std::cmp::Ordering::Equal),
        engine::Metric::Cosine => b
            .score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal),
    });
    all_hits.truncate(k);

    Ok(SearchResult {
        neighbors: all_hits
            .into_iter()
            .map(|hit| Neighbor {
                id: hit.document.id,
                title: hit.document.title,
                url: hit.document.url,
                score: hit.score,
            })
            .collect(),
    })
}

#[wasm_bindgen]
pub fn index(resource: Resource, options: Option<VoyOptions>) -> Result<SerializedIndex, JsError> {
    set_panic_hook();

    let metric = options
        .unwrap_or_default()
        .metric()
        .map_err(|error| JsError::new(&error.to_string()))?;
    let index =
        engine::index(resource, metric).map_err(|error| JsError::new(&error.to_string()))?;
    engine::serialize(&index).map_err(|error| JsError::new(&error.to_string()))
}

#[wasm_bindgen]
pub fn search(
    serialized_index: SerializedIndex,
    query: Query,
    k: NumberOfResult,
) -> Result<SearchResult, JsError> {
    set_panic_hook();

    let index =
        engine::deserialize(&serialized_index).map_err(|error| JsError::new(&error.to_string()))?;
    let neighbors =
        engine::search(&index, &query, k).map_err(|error| JsError::new(&error.to_string()))?;

    Ok(SearchResult {
        neighbors: neighbors
            .into_iter()
            .map(|hit| Neighbor {
                id: hit.document.id,
                title: hit.document.title,
                url: hit.document.url,
                score: hit.score,
            })
            .collect(),
    })
}

#[wasm_bindgen]
pub fn add(
    serialized_index: SerializedIndex,
    resource: Resource,
) -> Result<SerializedIndex, JsError> {
    set_panic_hook();

    let mut index =
        engine::deserialize(&serialized_index).map_err(|error| JsError::new(&error.to_string()))?;
    engine::add(&mut index, &resource).map_err(|error| JsError::new(&error.to_string()))?;
    engine::serialize(&index).map_err(|error| JsError::new(&error.to_string()))
}

#[wasm_bindgen]
pub fn remove(
    serialized_index: SerializedIndex,
    resource: Resource,
) -> Result<SerializedIndex, JsError> {
    set_panic_hook();

    let mut index =
        engine::deserialize(&serialized_index).map_err(|error| JsError::new(&error.to_string()))?;
    engine::remove(&mut index, &resource).map_err(|error| JsError::new(&error.to_string()))?;
    engine::serialize(&index).map_err(|error| JsError::new(&error.to_string()))
}

#[wasm_bindgen]
pub fn clear(serialized_index: SerializedIndex) -> Result<SerializedIndex, JsError> {
    set_panic_hook();

    let mut index =
        engine::deserialize(&serialized_index).map_err(|error| JsError::new(&error.to_string()))?;
    engine::clear(&mut index);
    engine::serialize(&index).map_err(|error| JsError::new(&error.to_string()))
}

#[wasm_bindgen]
pub fn size(serialized_index: SerializedIndex) -> Result<usize, JsError> {
    set_panic_hook();

    let index =
        engine::deserialize(&serialized_index).map_err(|error| JsError::new(&error.to_string()))?;
    Ok(engine::size(&index))
}
