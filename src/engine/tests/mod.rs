mod fixtures;

use crate::engine;
use crate::{EmbeddedResource, Resource};
use fixtures::*;
use rstest::*;

#[rstest]
fn it_indexes_embeddings(resource_fixture: Resource) {
    let index = engine::index(resource_fixture, engine::Metric::Euclidean).unwrap();

    assert_eq!(index.dimension, Some(768));
    assert_eq!(index.documents.len(), 6);
    assert_eq!(index.vectors.len(), 6 * 768);
}

#[rstest]
fn it_returns_legacy_vector_search_result(
    resource_fixture: Resource,
    question_fixture: [f32; 768],
    content_fixture: [&'static str; 6],
) {
    let index = engine::index(resource_fixture, engine::Metric::Euclidean).unwrap();
    let result = engine::search(&index, &question_fixture, 6).unwrap();

    assert_eq!(result[0].document.title, content_fixture[0]);
    assert_eq!(result[1].document.title, content_fixture[1]);
    assert_eq!(result[2].document.title, content_fixture[2]);
    assert_eq!(result[3].document.title, content_fixture[4]);
    assert_eq!(result[4].document.title, content_fixture[5]);
    assert_eq!(result[5].document.title, content_fixture[3]);
}

#[rstest]
fn it_adds_embeddings_to_index(
    resource_fixture: Resource,
    content_fixture: [&'static str; 6],
    embedding_fixture: [[f32; 768]; 6],
) {
    let mut index = engine::index(resource_fixture, engine::Metric::Euclidean).unwrap();
    let addition = Resource {
        embeddings: vec![EmbeddedResource {
            id: "5".to_owned(),
            title: content_fixture[5].to_string(),
            url: "".to_owned(),
            embeddings: embedding_fixture[5].to_vec(),
        }],
    };

    engine::add(&mut index, &addition).unwrap();

    assert_eq!(engine::size(&index), 7);
    assert_eq!(index.vectors.len(), 7 * 768);
}

#[rstest]
fn it_removes_embeddings_from_index(
    resource_fixture: Resource,
    content_fixture: [&'static str; 6],
    embedding_fixture: [[f32; 768]; 6],
) {
    let mut index = engine::index(resource_fixture, engine::Metric::Euclidean).unwrap();
    let target = Resource {
        embeddings: vec![EmbeddedResource {
            id: "1".to_owned(),
            title: content_fixture[1].to_string(),
            url: "".to_owned(),
            embeddings: embedding_fixture[1].to_vec(),
        }],
    };

    engine::remove(&mut index, &target).unwrap();

    assert_eq!(engine::size(&index), 5);
    assert_eq!(index.vectors.len(), 5 * 768);
}

#[rstest]
fn it_clears_all_embeddings_from_index(resource_fixture: Resource) {
    let mut index = engine::index(resource_fixture, engine::Metric::Euclidean).unwrap();

    engine::clear(&mut index);

    assert_eq!(engine::size(&index), 0);
    assert_eq!(index.dimension, None);
    assert!(index.documents.is_empty());
    assert!(index.vectors.is_empty());
}

#[rstest]
fn it_returns_the_size_of_index(resource_fixture: Resource) {
    let index = engine::index(resource_fixture, engine::Metric::Euclidean).unwrap();
    assert_eq!(engine::size(&index), 6);
}

#[rstest]
fn it_round_trips_the_binary_index(resource_fixture: Resource, question_fixture: [f32; 768]) {
    let index = engine::index(resource_fixture, engine::Metric::Euclidean).unwrap();
    let serialized = engine::serialize(&index).unwrap();
    let deserialized = engine::deserialize(&serialized).unwrap();

    let original = engine::search(&index, &question_fixture, 3).unwrap();
    let round_tripped = engine::search(&deserialized, &question_fixture, 3).unwrap();

    assert_eq!(original.len(), round_tripped.len());
    assert_eq!(original[0].document.title, round_tripped[0].document.title);
    assert_eq!(original[1].document.title, round_tripped[1].document.title);
    assert_eq!(original[2].document.title, round_tripped[2].document.title);
    assert_eq!(original[0].score, round_tripped[0].score);
}

#[test]
fn it_rejects_dimension_mismatch() {
    let resource = Resource {
        embeddings: vec![
            EmbeddedResource {
                id: "a".to_owned(),
                title: "first".to_owned(),
                url: "/a".to_owned(),
                embeddings: vec![1.0, 0.0, 0.0],
            },
            EmbeddedResource {
                id: "b".to_owned(),
                title: "second".to_owned(),
                url: "/b".to_owned(),
                embeddings: vec![0.0, 1.0],
            },
        ],
    };

    let error = engine::index(resource, engine::Metric::Euclidean).unwrap_err();
    assert!(error.to_string().contains("same dimension"));
}

#[test]
fn it_returns_empty_results_for_an_empty_index() {
    let index = engine::Index::new(engine::Metric::Euclidean);
    let result = engine::search(&index, &[1.0, 0.0, 0.0], 5).unwrap();

    assert!(result.is_empty());
}

#[rstest]
fn it_returns_all_neighbors_when_k_exceeds_index_size(
    resource_fixture: Resource,
    question_fixture: [f32; 768],
) {
    let index = engine::index(resource_fixture, engine::Metric::Euclidean).unwrap();
    let result = engine::search(&index, &question_fixture, 100).unwrap();

    assert_eq!(result.len(), 6);
}

#[test]
fn it_supports_cosine_search() {
    let resource = Resource {
        embeddings: vec![
            EmbeddedResource {
                id: "a".to_owned(),
                title: "right".to_owned(),
                url: "/a".to_owned(),
                embeddings: vec![1.0, 0.0, 0.0],
            },
            EmbeddedResource {
                id: "b".to_owned(),
                title: "up".to_owned(),
                url: "/b".to_owned(),
                embeddings: vec![0.0, 1.0, 0.0],
            },
            EmbeddedResource {
                id: "c".to_owned(),
                title: "diag".to_owned(),
                url: "/c".to_owned(),
                embeddings: vec![1.0, 1.0, 0.0],
            },
        ],
    };

    let index = engine::index(resource, engine::Metric::Cosine).unwrap();
    let result = engine::search(&index, &[2.0, 2.0, 0.0], 3).unwrap();

    assert_eq!(result[0].document.title, "diag");
    assert!(result[0].score > result[1].score);
}

#[rstest]
fn it_keeps_the_same_size_when_removing_a_missing_document(
    resource_fixture: Resource,
    embedding_fixture: [[f32; 768]; 6],
) {
    let mut index = engine::index(resource_fixture, engine::Metric::Euclidean).unwrap();
    let missing = Resource {
        embeddings: vec![EmbeddedResource {
            id: "missing".to_owned(),
            title: "missing".to_owned(),
            url: "/missing".to_owned(),
            embeddings: embedding_fixture[0].to_vec(),
        }],
    };

    engine::remove(&mut index, &missing).unwrap();

    assert_eq!(engine::size(&index), 6);
}
