ALTER TABLE chat_turns ADD COLUMN observability JSONB;
ALTER TABLE chat_turns ADD CONSTRAINT chat_turns_observability_object
  CHECK (observability IS NULL OR jsonb_typeof(observability) = 'object');
