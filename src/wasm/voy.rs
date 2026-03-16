use crate::utils::set_panic_hook;
use crate::{
    Neighbor, NumberOfResult, Query, Resource, SearchResult, SerializedIndex, VoyOptions, engine,
};

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
#[derive(Debug)]
pub struct Voy {
    index: engine::Index,
}

#[wasm_bindgen]
impl Voy {
    #[wasm_bindgen(constructor)]
    pub fn new(resource: Option<Resource>, options: Option<VoyOptions>) -> Result<Voy, JsError> {
        set_panic_hook();

        let metric = options
            .unwrap_or_default()
            .metric()
            .map_err(|error| JsError::new(&error.to_string()))?;
        let index = match resource {
            Some(resource) => {
                engine::index(resource, metric).map_err(|error| JsError::new(&error.to_string()))?
            }
            None => engine::Index::new(metric),
        };

        Ok(Voy { index })
    }

    pub fn serialize(&self) -> Result<SerializedIndex, JsError> {
        engine::serialize(&self.index).map_err(|error| JsError::new(&error.to_string()))
    }

    pub fn deserialize(serialized_index: SerializedIndex) -> Result<Voy, JsError> {
        let index = engine::deserialize(&serialized_index)
            .map_err(|error| JsError::new(&error.to_string()))?;
        Ok(Voy { index })
    }

    pub fn index(
        &mut self,
        resource: Resource,
        options: Option<VoyOptions>,
    ) -> Result<(), JsError> {
        let metric = options
            .unwrap_or(VoyOptions {
                metric: Some(match self.index.metric {
                    engine::Metric::Euclidean => "euclidean".to_owned(),
                    engine::Metric::Cosine => "cosine".to_owned(),
                }),
            })
            .metric()
            .map_err(|error| JsError::new(&error.to_string()))?;
        let index =
            engine::index(resource, metric).map_err(|error| JsError::new(&error.to_string()))?;
        self.index = index;
        Ok(())
    }

    pub fn search(&self, query: Query, k: NumberOfResult) -> Result<SearchResult, JsError> {
        let neighbors = engine::search(&self.index, &query, k)
            .map_err(|error| JsError::new(&error.to_string()))?;
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

    pub fn add(&mut self, resource: Resource) -> Result<(), JsError> {
        engine::add(&mut self.index, &resource).map_err(|error| JsError::new(&error.to_string()))
    }

    pub fn remove(&mut self, resource: Resource) -> Result<(), JsError> {
        engine::remove(&mut self.index, &resource).map_err(|error| JsError::new(&error.to_string()))
    }

    pub fn clear(&mut self) {
        engine::clear(&mut self.index);
    }

    pub fn size(&self) -> usize {
        engine::size(&self.index)
    }
}
