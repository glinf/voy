use super::{Voy, VoyOptions, add, clear, index, remove, search, size};
use crate::{EmbeddedResource, Resource};

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

#[test]
fn voy_round_trips_binary_indexes() {
    let voy = Voy::new(Some(resource()), None).unwrap();
    let serialized = voy.serialize().unwrap();
    let deserialized = Voy::deserialize(serialized).unwrap();
    let result = deserialized.search(vec![1.0, 0.0, 0.0], 1).unwrap();

    assert_eq!(result.neighbors[0].title, "alpha");
    assert!(result.neighbors[0].score.is_finite());
}

#[test]
fn standalone_functions_match_instance_api() {
    let mut voy = Voy::new(Some(resource()), None).unwrap();
    voy.add(addition()).unwrap();
    let instance = voy.search(vec![0.5, 0.5, 0.0], 3).unwrap();

    let mut serialized = index(resource(), None).unwrap();
    serialized = add(serialized, addition()).unwrap();
    let free_fn = search(serialized, vec![0.5, 0.5, 0.0], 3).unwrap();

    assert_eq!(instance.neighbors.len(), free_fn.neighbors.len());
    assert_eq!(instance.neighbors[0].title, free_fn.neighbors[0].title);
    assert_eq!(instance.neighbors[1].title, free_fn.neighbors[1].title);
    assert_eq!(instance.neighbors[0].score, free_fn.neighbors[0].score);
}

#[test]
fn standalone_functions_update_size_after_remove_and_clear() {
    let serialized = index(resource(), None).unwrap();
    let serialized = add(serialized, addition()).unwrap();
    assert_eq!(size(serialized.clone()).unwrap(), 3);

    let serialized = remove(serialized, addition()).unwrap();
    assert_eq!(size(serialized.clone()).unwrap(), 2);

    let serialized = clear(serialized).unwrap();
    assert_eq!(size(serialized).unwrap(), 0);
}

#[test]
fn cosine_metric_is_configurable() {
    let voy = Voy::new(
        Some(resource()),
        Some(VoyOptions {
            metric: Some("cosine".to_owned()),
        }),
    )
    .unwrap();

    let result = voy.search(vec![1.0, 0.0, 0.0], 1).unwrap();
    assert_eq!(result.neighbors[0].title, "alpha");
}

#[test]
fn voy_index_replaces_existing_data() {
    let mut voy = Voy::new(Some(resource()), None).unwrap();
    assert_eq!(voy.size(), 2);

    let new_resource = Resource {
        embeddings: vec![EmbeddedResource {
            id: "x".to_owned(),
            title: "xi".to_owned(),
            url: "/x".to_owned(),
            embeddings: vec![0.0, 0.0, 1.0],
        }],
    };
    voy.index(new_resource, None).unwrap();

    assert_eq!(voy.size(), 1);
    let result = voy.search(vec![0.0, 0.0, 1.0], 1).unwrap();
    assert_eq!(result.neighbors[0].title, "xi");
}

#[test]
fn voy_new_without_resource_creates_empty_index() {
    let voy = Voy::new(None, None).unwrap();
    assert_eq!(voy.size(), 0);

    let result = voy.search(vec![1.0, 0.0, 0.0], 1).unwrap();
    assert!(result.neighbors.is_empty());
}

#[test]
fn voy_remove_and_clear_update_state() {
    let mut voy = Voy::new(Some(resource()), None).unwrap();
    assert_eq!(voy.size(), 2);

    let target = Resource {
        embeddings: vec![EmbeddedResource {
            id: "a".to_owned(),
            title: "alpha".to_owned(),
            url: "/a".to_owned(),
            embeddings: vec![1.0, 0.0, 0.0],
        }],
    };
    voy.remove(target).unwrap();
    assert_eq!(voy.size(), 1);

    voy.clear();
    assert_eq!(voy.size(), 0);
}

#[test]
fn invalid_metric_string_is_rejected() {
    let options = VoyOptions {
        metric: Some("hamming".to_owned()),
    };
    let error = options.metric().unwrap_err();
    assert!(error.to_string().contains("metric"));
}
