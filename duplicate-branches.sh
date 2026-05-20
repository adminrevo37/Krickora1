#!/bin/bash

set -e

echo "🚀 Branch Duplication Script"
echo "=============================="
echo ""

# SOURCE_BRANCHES=(
#   "calculator-template"
#   "content-sharing-template"
#   "landing-page-template"
#   "todo-template"
#   "tracker-template"
# )


SOURCE_BRANCHES=(
  "main"
)

CURRENT_BRANCH="database-template"

FILES_TO_COPY=(
  "src/database"
  "src/entities"
  "src/repositories"
  "src/hooks/useEntity.ts"
  "src/lib/db-utils.ts"
  "src/components/UserExample.tsx"
)

echo "Current branch: $CURRENT_BRANCH"
echo "Source branches to duplicate: ${SOURCE_BRANCHES[*]}"
echo ""

for SOURCE_BRANCH in "${SOURCE_BRANCHES[@]}"; do
  NEW_BRANCH="database-$SOURCE_BRANCH"
  
  echo "----------------------------------------"
  echo "Processing: $SOURCE_BRANCH -> $NEW_BRANCH"
  echo "----------------------------------------"
  
  if git show-ref --verify --quiet "refs/heads/$NEW_BRANCH"; then
    echo "⏭️  Branch $NEW_BRANCH already exists, skipping..."
    continue
  fi
  
  if ! git show-ref --verify --quiet "refs/heads/$SOURCE_BRANCH" && \
     ! git show-ref --verify --quiet "refs/remotes/origin/$SOURCE_BRANCH"; then
    echo "⚠️  Source branch $SOURCE_BRANCH does not exist locally or remotely, skipping..."
    continue
  fi
  
  SOURCE_REF="$SOURCE_BRANCH"
  if ! git show-ref --verify --quiet "refs/heads/$SOURCE_BRANCH"; then
    SOURCE_REF="origin/$SOURCE_BRANCH"
    echo "Using remote branch origin/$SOURCE_BRANCH"
  fi
  
  echo "Creating branch $NEW_BRANCH from $SOURCE_REF..."
  git checkout -b "$NEW_BRANCH" "$SOURCE_REF"
  
  echo "Copying database files from $CURRENT_BRANCH..."
  for FILE in "${FILES_TO_COPY[@]}"; do
    echo "  - Copying $FILE"
    
    if [ -d "../$CURRENT_BRANCH/$FILE" ] || git show "$CURRENT_BRANCH:$FILE" &> /dev/null; then
      PARENT_DIR=$(dirname "$FILE")
      
      if [ "$PARENT_DIR" != "." ] && [ ! -d "$PARENT_DIR" ]; then
        mkdir -p "$PARENT_DIR"
      fi
      
      git checkout "$CURRENT_BRANCH" -- "$FILE"
    else
      echo "    ⚠️  Warning: $FILE not found in $CURRENT_BRANCH, skipping..."
    fi
  done
  
  echo "Adding @libsql/client dependency to package.json..."
  
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    
    if (!pkg.dependencies) {
      pkg.dependencies = {};
    }
    
    pkg.dependencies['@libsql/client'] = '^0.15.15';
    
    const sortedDeps = Object.keys(pkg.dependencies)
      .sort()
      .reduce((acc, key) => {
        acc[key] = pkg.dependencies[key];
        return acc;
      }, {});
    
    pkg.dependencies = sortedDeps;
    
    fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
    console.log('  ✅ Added @libsql/client dependency');
  "
  
  echo "Committing changes..."
  git add .
  git commit -m "Add database functionality from database-template

- Added database layer (src/database/)
- Added entity system (src/entities/)
- Added flexible repository (src/repositories/)
- Added useEntity hook
- Added database utilities
- Added UserExample component
- Added @libsql/client dependency"
  
  echo "✅ Successfully created and configured $NEW_BRANCH"
  echo ""
done

echo "Returning to $CURRENT_BRANCH..."
git checkout "$CURRENT_BRANCH"

echo ""
echo "=============================="
echo "✅ Script completed successfully!"
echo "=============================="
echo ""
echo "Created branches:"
for SOURCE_BRANCH in "${SOURCE_BRANCHES[@]}"; do
  NEW_BRANCH="database-$SOURCE_BRANCH"
  if git show-ref --verify --quiet "refs/heads/$NEW_BRANCH"; then
    echo "  ✓ $NEW_BRANCH"
  fi
done
echo ""
echo "To push all new branches to remote, run:"
echo "  git push origin database-calculator-template database-content-sharing-template database-landing-page-template database-todo-template database-tracker-template"

