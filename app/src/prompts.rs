//! Prompt library and ordered queue; compatible with the previous JSON export format.
use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Prompt {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub created_at: u64,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Library {
    pub prompts: Vec<Prompt>,
    pub queue: Vec<String>,
}
impl Library {
    pub fn load(conn: &Connection) -> Result<Self> {
        conn.execute_batch("CREATE TABLE IF NOT EXISTS prompt_library(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);")?;
        use rusqlite::OptionalExtension;
        let data: Option<String> = conn
            .query_row("SELECT data FROM prompt_library WHERE id=1", [], |r| {
                r.get(0)
            })
            .optional()?;
        data.map(|s| Self::parse(&s)).unwrap_or(Ok(Self::default()))
    }
    pub fn save(&self, conn: &Connection) -> Result<()> {
        conn.execute("INSERT INTO prompt_library(id,data) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET data=excluded.data",params![serde_json::to_string(self)?])?;
        Ok(())
    }
    pub fn parse(text: &str) -> Result<Self> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Export {
            State(Library),
            Legacy(Vec<Prompt>),
        }
        let mut library = match serde_json::from_str(text).context("Invalid prompt JSON")? {
            Export::State(s) => s,
            Export::Legacy(prompts) => Self {
                prompts,
                queue: vec![],
            },
        };
        let mut ids = HashSet::new();
        for p in &mut library.prompts {
            if p.text.trim().is_empty() || p.id.is_empty() || !ids.insert(p.id.clone()) {
                bail!("Prompts require unique IDs and nonempty text");
            }
            normalize_tags(&mut p.tags);
        }
        let mut queued = HashSet::new();
        library
            .queue
            .retain(|id| ids.contains(id) && queued.insert(id.clone()));
        Ok(library)
    }
    pub fn add(&mut self, text: String, tags: Vec<String>) -> Result<String> {
        if text.trim().is_empty() {
            bail!("Enter a prompt first");
        }
        let mut id = crate::workspace_view::now().to_string();
        while self.prompts.iter().any(|p| p.id == id) {
            id.push('0');
        }
        let mut tags = tags;
        normalize_tags(&mut tags);
        self.prompts.insert(
            0,
            Prompt {
                id: id.clone(),
                text,
                tags,
                created_at: (crate::workspace_view::now() / 1000) as u64,
            },
        );
        Ok(id)
    }
    pub fn delete(&mut self, id: &str) {
        self.prompts.retain(|p| p.id != id);
        self.queue.retain(|p| p != id);
    }
    pub fn enqueue(&mut self, id: &str) {
        if self.prompts.iter().any(|p| p.id == id) && !self.queue.iter().any(|p| p == id) {
            self.queue.push(id.into());
        }
    }
    pub fn merge(&mut self, other: Self) {
        let mut remap = std::collections::HashMap::new();
        for mut prompt in other.prompts {
            let original = prompt.id.clone();
            if let Some(existing) = self.prompts.iter().find(|p| p.id == prompt.id) {
                if existing == &prompt {
                    remap.insert(original, prompt.id);
                    continue;
                }
                while self.prompts.iter().any(|p| p.id == prompt.id) {
                    prompt.id.push('0');
                }
            }
            remap.insert(original, prompt.id.clone());
            self.prompts.push(prompt);
        }
        for id in other.queue {
            if let Some(mapped) = remap.get(&id) {
                self.enqueue(mapped);
            }
        }
    }
    pub fn move_queue(&mut self, index: usize, delta: isize) {
        let next = index as isize + delta;
        if index < self.queue.len() && next >= 0 && (next as usize) < self.queue.len() {
            self.queue.swap(index, next as usize);
        }
    }
}
fn normalize_tags(tags: &mut Vec<String>) {
    *tags = tags
        .iter()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    tags.sort();
    tags.dedup();
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn persistence_preserves_order_and_tags() {
        let c = Connection::open_in_memory().unwrap();
        let mut l = Library::load(&c).unwrap();
        let a = l
            .add("one".into(), vec![" Rust ".into(), "rust".into()])
            .unwrap();
        let b = l.add("two".into(), vec![]).unwrap();
        l.enqueue(&a);
        l.enqueue(&b);
        l.move_queue(1, -1);
        l.save(&c).unwrap();
        assert_eq!(Library::load(&c).unwrap(), l);
        assert_eq!(l.prompts[1].tags, vec!["rust"]);
        l.delete(&b);
        assert_eq!(l.queue, vec![a]);
    }
    #[test]
    fn imports_legacy_and_cleans_queue() {
        let l = Library::parse(
            r#"{"prompts":[{"id":"1","text":"hello"}],"queue":["missing","1","1"]}"#,
        )
        .unwrap();
        assert_eq!(l.queue, vec!["1"]);
        assert!(Library::parse(r#"[{"id":"a","text":""}]"#).is_err());
    }
}
