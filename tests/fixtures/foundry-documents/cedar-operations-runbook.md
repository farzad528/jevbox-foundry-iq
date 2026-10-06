# Cedar Operations Runbook

This document is fictional demonstration data.

## Restore objectives

The restore drill target is a recovery time of 30 minutes and a recovery point of 5 minutes.
These are drill targets, not customer service-level guarantees.

## Daily backup

A full backup starts at 02:00 UTC each day.

## Failed synchronization

Keep affected content blocked while permission synchronization is pending or failed.
Retry only the current fenced attempt; do not publish an obsolete source revision.
The Operations Lead must record verified native denial before closing a revocation incident.
