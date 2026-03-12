//! Test suite for the Web and headless browsers.

#![cfg(target_arch = "wasm32")]

use voy_search::{EmbeddedResource, Resource, Voy, VoyOptions, add, index, search};
use wasm_bindgen_test::*;

wasm_bindgen_test_configure!(run_in_browser);

fn resource() -> Resource {
    Resource {
        embeddings: vec![
            EmbeddedResource {
                id: "a".to_owned(),
                title: "alpha".to_owned(),
                url: "/a".to_owned(),
                embeddings: vec![1.0, 0.0, 0.0],
            },
            EmbeddedResource {
                id: "b".to_owned(),
                title: "beta".to_owned(),
                url: "/b".to_owned(),
                embeddings: vec![0.0, 1.0, 0.0],
            },
        ],
    }
}

fn addition() -> Resource {
    Resource {
        embeddings: vec![EmbeddedResource {
            id: "c".to_owned(),
            title: "gamma".to_owned(),
            url: "/c".to_owned(),
            embeddings: vec![0.5, 0.5, 0.0],
        }],
    }
}

#[wasm_bindgen_test]
fn public_api_round_trips_binary_indexes() {
    let voy = Voy::new(Some(resource()), None).unwrap();
    let serialized = voy.serialize().unwrap();
    let restored = Voy::deserialize(serialized).unwrap();
    let result = restored.search(vec![1.0, 0.0, 0.0], 1).unwrap();

    assert_eq!(result.neighbors[0].title, "alpha");
}

#[wasm_bindgen_test]
fn standalone_functions_work_in_browser() {
    let serialized = index(resource(), Some(VoyOptions::default())).unwrap();
    let serialized = add(serialized, addition()).unwrap();
    let result = search(serialized, vec![0.5, 0.5, 0.0], 3).unwrap();

    assert_eq!(result.neighbors[0].title, "gamma");
}

#[wasm_bindgen_test]
fn invalid_bytes_fail_in_browser() {
    let error = Voy::deserialize(vec![0, 1, 2]).unwrap_err();
    assert!(format!("{error:?}").contains("serialized index"));
}
