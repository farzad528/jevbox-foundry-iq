# Cedar Architecture

This document is fictional demonstration data.

## System of record

PostgreSQL stores canonical document metadata and knowledge-page revisions.
The retrieval index stores derived evidence, not the canonical source of record.

## Knowledge publication

Only reviewed, current knowledge-page revisions enter normal retrieval.
Every published claim must reference current raw-source evidence.

## Permissions

A knowledge page may be read only by readers allowed by its own grants and every transitive raw-source dependency.
A pending permission synchronization blocks affected local reads and answer publication.
The application does not promise recall of content already delivered to a reader.
