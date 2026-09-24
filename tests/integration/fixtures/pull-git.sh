#!/bin/sh
if [ "$1" = pull ]; then
  name=$(basename "$PWD")
  printf 'start %s\n' "$name" >> "$PULL_LOG"
  IFS= read -r signal < "$PULL_BARRIERS/$name"
  if [ "$signal" = fail ]; then
    printf 'end %s\n' "$name" >> "$PULL_LOG"
    exit 1
  fi
  if [ "$signal" = timeout ]; then
    printf 'end %s\n' "$name" >> "$PULL_LOG"
    exit 1
  fi
  /usr/bin/git "$@"
  result=$?
  printf 'end %s\n' "$name" >> "$PULL_LOG"
  exit "$result"
fi
if [ "$1" = reset ] && [ "$(basename "$PWD")" = repo-02 ]; then
  printf 'rollback repo-02\n' >> "$PULL_LOG"
fi
exec /usr/bin/git "$@"
