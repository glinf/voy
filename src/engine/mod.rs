mod engine;

#[cfg(test)]
mod tests;

pub use engine::{
    Index, Metric, add, clear, deserialize, index, multi_shard_search, remove, search, serialize,
    size,
};
