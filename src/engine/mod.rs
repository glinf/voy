mod engine;

#[cfg(test)]
mod tests;

pub use engine::{Index, Metric, add, clear, deserialize, index, remove, search, serialize, size};
