#!/bin/bash
# Example setup script for arashi hooks
# This file should be placed at .arashi/hooks/setup.sh

set -e

echo "🔧 Setting up development environment..."

# Setup each repository in the repos/ folder
for repo_dir in repos/*/; do
  if [ ! -d "$repo_dir" ]; then
    continue
  fi
  
  repo_name=$(basename "$repo_dir")
  echo ""
  echo "Setting up $repo_name..."
  
  cd "$repo_dir"
  
  # Run repo-specific setup if it exists
  if [ -f "setup.sh" ]; then
    echo "  Running $repo_name/setup.sh..."
    ./setup.sh
  elif [ -f "package.json" ]; then
    echo "  Installing npm dependencies..."
    npm install
  elif [ -f "requirements.txt" ]; then
    echo "  Installing Python dependencies..."
    pip install -r requirements.txt
  elif [ -f "go.mod" ]; then
    echo "  Installing Go dependencies..."
    go mod download
  else
    echo "  No setup script found, skipping..."
  fi
  
  cd - > /dev/null
done

echo ""
echo "✅ Setup complete!"
