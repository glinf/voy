use crate::Resource;
use anyhow::{Context, bail, ensure};
use std::cmp::Ordering;
use std::collections::BinaryHeap;

const FORMAT_MAGIC: &[u8; 4] = b"VOY1";
const METRIC_EUCLIDEAN: u8 = 0;
const METRIC_COSINE: u8 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Document {
    pub id: String,
    pub title: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SearchHit {
    pub document: Document,
    pub score: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Metric {
    Euclidean,
    Cosine,
}

impl Default for Metric {
    fn default() -> Self {
        Self::Euclidean
    }
}

impl Metric {
    fn as_byte(self) -> u8 {
        match self {
            Self::Euclidean => METRIC_EUCLIDEAN,
            Self::Cosine => METRIC_COSINE,
        }
    }

    fn from_byte(value: u8) -> anyhow::Result<Self> {
        match value {
            METRIC_EUCLIDEAN => Ok(Self::Euclidean),
            METRIC_COSINE => Ok(Self::Cosine),
            _ => bail!("unsupported metric byte: {value}"),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Index {
    pub dimension: Option<usize>,
    pub metric: Metric,
    pub documents: Vec<Document>,
    pub vectors: Vec<f32>,
}

impl Index {
    pub fn new(metric: Metric) -> Self {
        Self {
            dimension: None,
            metric,
            documents: Vec::new(),
            vectors: Vec::new(),
        }
    }

    fn dimension(&self) -> anyhow::Result<usize> {
        self.dimension.context("index dimension is not set")
    }

    fn vector_at(&self, offset: usize) -> &[f32] {
        let dimension = self.dimension.expect("vector_at requires a dimension");
        let start = offset * dimension;
        let end = start + dimension;
        &self.vectors[start..end]
    }
}

#[derive(Debug, Clone, PartialEq)]
struct RankedHit {
    rank_score: f32,
    index: usize,
}

impl Eq for RankedHit {}

impl Ord for RankedHit {
    fn cmp(&self, other: &Self) -> Ordering {
        self.rank_score
            .partial_cmp(&other.rank_score)
            .unwrap_or(Ordering::Equal)
            .then_with(|| self.index.cmp(&other.index))
    }
}

impl PartialOrd for RankedHit {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

pub fn index(resource: Resource, metric: Metric) -> anyhow::Result<Index> {
    let mut index = Index::new(metric);
    add(&mut index, &resource)?;
    Ok(index)
}

pub fn search(index: &Index, query: &[f32], k: usize) -> anyhow::Result<Vec<SearchHit>> {
    if k == 0 || index.documents.is_empty() {
        return Ok(Vec::new());
    }

    let mut query = prepare_query(query, index.metric, index.dimension()?)?;
    if index.metric == Metric::Cosine {
        normalize(&mut query)?;
    }

    let mut heap: BinaryHeap<RankedHit> = BinaryHeap::new();
    for offset in 0..index.documents.len() {
        let candidate = index.vector_at(offset);
        let score = match index.metric {
            Metric::Euclidean => squared_euclidean(&query, candidate),
            Metric::Cosine => dot_product(&query, candidate),
        };
        let rank_score = match index.metric {
            Metric::Euclidean => score,
            Metric::Cosine => -score,
        };
        let hit = RankedHit {
            rank_score,
            index: offset,
        };

        if heap.len() < k {
            heap.push(hit);
            continue;
        }

        let should_replace = heap.peek().map(|worst| hit < *worst).unwrap_or(false);
        if should_replace {
            heap.pop();
            heap.push(hit);
        }
    }

    let mut hits = heap.into_vec();
    hits.sort_by(|left, right| {
        left.rank_score
            .total_cmp(&right.rank_score)
            .then(left.index.cmp(&right.index))
    });

    Ok(hits
        .into_iter()
        .map(|hit| SearchHit {
            document: index.documents[hit.index].clone(),
            score: match index.metric {
                Metric::Euclidean => hit.rank_score,
                Metric::Cosine => -hit.rank_score,
            },
        })
        .collect())
}

pub fn add(index: &mut Index, resource: &Resource) -> anyhow::Result<()> {
    let dimension = resolve_dimension(index.dimension, resource)?;
    if dimension == 0 {
        return Ok(());
    }

    index.dimension = Some(dimension);

    for item in &resource.embeddings {
        let document = Document {
            id: item.id.clone(),
            title: item.title.clone(),
            url: item.url.clone(),
        };
        let vector = prepare_vector(&item.embeddings, index.metric, dimension)?;

        index.documents.push(document);
        index.vectors.extend_from_slice(&vector);
    }

    Ok(())
}

pub fn remove(index: &mut Index, resource: &Resource) -> anyhow::Result<()> {
    let Some(dimension) = index.dimension else {
        return Ok(());
    };

    for item in &resource.embeddings {
        if item.embeddings.len() != dimension {
            continue;
        }

        let vector = prepare_vector(&item.embeddings, index.metric, dimension)?;
        let candidate = Document {
            id: item.id.clone(),
            title: item.title.clone(),
            url: item.url.clone(),
        };

        if let Some(position) = index
            .documents
            .iter()
            .zip(index.vectors.chunks_exact(dimension))
            .position(|(document, stored_vector)| {
                document == &candidate && stored_vector == vector.as_slice()
            })
        {
            index.documents.remove(position);
            let start = position * dimension;
            let end = start + dimension;
            index.vectors.drain(start..end);
        }
    }

    if index.documents.is_empty() {
        index.dimension = None;
        index.vectors.clear();
    }

    Ok(())
}

pub fn clear(index: &mut Index) {
    index.dimension = None;
    index.documents.clear();
    index.vectors.clear();
}

pub fn size(index: &Index) -> usize {
    index.documents.len()
}

pub fn serialize(index: &Index) -> anyhow::Result<Vec<u8>> {
    let dimension = index.dimension.unwrap_or_default();
    ensure!(
        u16::try_from(dimension).is_ok(),
        "dimension exceeds u16 storage"
    );
    ensure!(
        u32::try_from(index.documents.len()).is_ok(),
        "document count exceeds u32 storage"
    );

    let mut bytes = Vec::new();
    bytes.extend_from_slice(FORMAT_MAGIC);
    bytes.push(index.metric.as_byte());
    bytes.extend_from_slice(&(dimension as u16).to_le_bytes());
    bytes.extend_from_slice(&(index.documents.len() as u32).to_le_bytes());

    for document in &index.documents {
        write_string(&mut bytes, &document.id)?;
        write_string(&mut bytes, &document.title)?;
        write_string(&mut bytes, &document.url)?;
    }

    for value in &index.vectors {
        bytes.extend_from_slice(&value.to_le_bytes());
    }

    Ok(bytes)
}

pub fn deserialize(bytes: &[u8]) -> anyhow::Result<Index> {
    ensure!(bytes.len() >= 11, "serialized index is too short");
    ensure!(
        &bytes[..4] == FORMAT_MAGIC,
        "invalid serialized index header"
    );

    let metric = Metric::from_byte(bytes[4])?;
    let mut cursor = 5;
    let dimension = read_u16(bytes, &mut cursor)? as usize;
    let count = read_u32(bytes, &mut cursor)? as usize;

    let mut documents = Vec::with_capacity(count);
    for _ in 0..count {
        let id = read_string(bytes, &mut cursor)?;
        let title = read_string(bytes, &mut cursor)?;
        let url = read_string(bytes, &mut cursor)?;
        documents.push(Document { id, title, url });
    }

    let expected_vector_bytes = count
        .checked_mul(dimension)
        .and_then(|value| value.checked_mul(std::mem::size_of::<f32>()))
        .context("serialized index is too large")?;
    ensure!(
        bytes.len().saturating_sub(cursor) == expected_vector_bytes,
        "serialized index vector payload size is invalid"
    );

    let total_floats = count.saturating_mul(dimension);
    let vector_bytes = &bytes[cursor..];
    let mut vectors = vec![0.0f32; total_floats];

    #[cfg(target_endian = "little")]
    {
        // SAFETY: lengths verified above, source/destination do not overlap
        unsafe {
            std::ptr::copy_nonoverlapping(
                vector_bytes.as_ptr(),
                vectors.as_mut_ptr() as *mut u8,
                expected_vector_bytes,
            );
        }
    }
    #[cfg(not(target_endian = "little"))]
    {
        for (i, chunk) in vector_bytes.chunks_exact(4).enumerate() {
            vectors[i] = f32::from_le_bytes(chunk.try_into().unwrap());
        }
    }

    ensure!(
        vectors.iter().all(|v| v.is_finite()),
        "serialized vector payload contains non-finite values"
    );

    Ok(Index {
        dimension: (dimension != 0).then_some(dimension),
        metric,
        documents,
        vectors,
    })
}

fn resolve_dimension(
    current_dimension: Option<usize>,
    resource: &Resource,
) -> anyhow::Result<usize> {
    if let Some(dimension) = current_dimension {
        if resource
            .embeddings
            .iter()
            .any(|item| item.embeddings.len() != dimension)
        {
            bail!("all embeddings must match the index dimension of {dimension}");
        }
        return Ok(dimension);
    }

    let mut items = resource.embeddings.iter();
    let Some(first) = items.next() else {
        return Ok(0);
    };
    let dimension = first.embeddings.len();
    ensure!(dimension > 0, "embeddings must not be empty");
    for item in items {
        ensure!(
            item.embeddings.len() == dimension,
            "all embeddings must have the same dimension"
        );
    }
    Ok(dimension)
}

fn prepare_query(query: &[f32], metric: Metric, dimension: usize) -> anyhow::Result<Vec<f32>> {
    prepare_vector(query, metric, dimension)
}

fn prepare_vector(
    embeddings: &[f32],
    metric: Metric,
    dimension: usize,
) -> anyhow::Result<Vec<f32>> {
    ensure!(dimension > 0, "embeddings must not be empty");
    ensure!(
        embeddings.len() == dimension,
        "expected {dimension}-dimensional embeddings but received {}",
        embeddings.len()
    );
    ensure!(
        embeddings.iter().all(|value| value.is_finite()),
        "embeddings must contain only finite values"
    );

    let mut vector = embeddings.to_vec();
    if metric == Metric::Cosine {
        normalize(&mut vector)?;
    }
    Ok(vector)
}

fn normalize(vector: &mut [f32]) -> anyhow::Result<()> {
    let norm = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
    ensure!(
        norm.is_finite() && norm > 0.0,
        "embeddings must have a non-zero norm"
    );
    for value in vector {
        *value /= norm;
    }
    Ok(())
}

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
fn squared_euclidean(left: &[f32], right: &[f32]) -> f32 {
    use core::arch::wasm32::*;

    let chunks = left.len() / 4;
    let mut acc = f32x4_splat(0.0);

    for i in 0..chunks {
        let offset = i * 4;
        let l = unsafe { v128_load(left.as_ptr().add(offset) as *const v128) };
        let r = unsafe { v128_load(right.as_ptr().add(offset) as *const v128) };
        let diff = f32x4_sub(l, r);
        acc = f32x4_add(acc, f32x4_mul(diff, diff));
    }

    let mut sum = f32x4_extract_lane::<0>(acc)
        + f32x4_extract_lane::<1>(acc)
        + f32x4_extract_lane::<2>(acc)
        + f32x4_extract_lane::<3>(acc);

    for i in (chunks * 4)..left.len() {
        let diff = left[i] - right[i];
        sum += diff * diff;
    }

    sum
}

#[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
fn squared_euclidean(left: &[f32], right: &[f32]) -> f32 {
    left.iter()
        .zip(right.iter())
        .map(|(left, right)| {
            let difference = left - right;
            difference * difference
        })
        .sum()
}

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
fn dot_product(left: &[f32], right: &[f32]) -> f32 {
    use core::arch::wasm32::*;

    let chunks = left.len() / 4;
    let mut acc = f32x4_splat(0.0);

    for i in 0..chunks {
        let offset = i * 4;
        let l = unsafe { v128_load(left.as_ptr().add(offset) as *const v128) };
        let r = unsafe { v128_load(right.as_ptr().add(offset) as *const v128) };
        acc = f32x4_add(acc, f32x4_mul(l, r));
    }

    let mut sum = f32x4_extract_lane::<0>(acc)
        + f32x4_extract_lane::<1>(acc)
        + f32x4_extract_lane::<2>(acc)
        + f32x4_extract_lane::<3>(acc);

    for i in (chunks * 4)..left.len() {
        sum += left[i] * right[i];
    }

    sum
}

#[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
fn dot_product(left: &[f32], right: &[f32]) -> f32 {
    left.iter()
        .zip(right.iter())
        .map(|(left, right)| left * right)
        .sum()
}

fn write_string(bytes: &mut Vec<u8>, value: &str) -> anyhow::Result<()> {
    ensure!(
        u32::try_from(value.len()).is_ok(),
        "string value exceeds u32 storage"
    );
    bytes.extend_from_slice(&(value.len() as u32).to_le_bytes());
    bytes.extend_from_slice(value.as_bytes());
    Ok(())
}

fn read_u16(bytes: &[u8], cursor: &mut usize) -> anyhow::Result<u16> {
    let slice = bytes
        .get(*cursor..*cursor + 2)
        .context("serialized index ended unexpectedly while reading u16")?;
    *cursor += 2;
    Ok(u16::from_le_bytes(slice.try_into().unwrap()))
}

fn read_u32(bytes: &[u8], cursor: &mut usize) -> anyhow::Result<u32> {
    let slice = bytes
        .get(*cursor..*cursor + 4)
        .context("serialized index ended unexpectedly while reading u32")?;
    *cursor += 4;
    Ok(u32::from_le_bytes(slice.try_into().unwrap()))
}

fn read_string(bytes: &[u8], cursor: &mut usize) -> anyhow::Result<String> {
    let length = read_u32(bytes, cursor)? as usize;
    let slice = bytes
        .get(*cursor..*cursor + length)
        .context("serialized index ended unexpectedly while reading string payload")?;
    *cursor += length;
    String::from_utf8(slice.to_vec()).context("serialized index contains invalid UTF-8")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranked_hits_sort_best_first() {
        let mut hits = vec![
            RankedHit {
                rank_score: 4.0,
                index: 4,
            },
            RankedHit {
                rank_score: 1.0,
                index: 2,
            },
            RankedHit {
                rank_score: 1.0,
                index: 1,
            },
        ];

        hits.sort_by(|left, right| {
            left.rank_score
                .total_cmp(&right.rank_score)
                .then(left.index.cmp(&right.index))
        });

        assert_eq!(
            hits,
            vec![
                RankedHit {
                    rank_score: 1.0,
                    index: 1,
                },
                RankedHit {
                    rank_score: 1.0,
                    index: 2,
                },
                RankedHit {
                    rank_score: 4.0,
                    index: 4,
                },
            ]
        );
    }
}
