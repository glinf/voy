use crate::{
    Neighbor, NumberOfResult, Query, Resource, SearchResult, SerializedIndex, VoyOptions, engine,
    utils::set_panic_hook,
};
use wasm_bindgen::prelude::*;

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
            .map(|document| Neighbor {
                id: document.id,
                title: document.title,
                url: document.url,
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
