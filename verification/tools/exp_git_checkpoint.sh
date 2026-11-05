#!/usr/bin/env bash
# Empirical checks for design_draft_rev3 §6 (Git ref checkpoints).
# Usage: bash exp_git_checkpoint.sh <empty-work-dir-on-NTFS>
set -u
W="$1"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
EMPTY_TREE=4b825dc642cb6eb9a060e54bf8d69288fbee4904
mtime() { stat -c %Y.%y "$1" | cut -d. -f1,3 | tr -d ' '; }
say() { echo "[$1] $2"; }

rm -rf "$W" && mkdir -p "$W" && cd "$W" || exit 1
git init -q repo && cd repo
git -c user.name=t -c user.email=t@t config core.autocrlf true
for i in $(seq 1 50); do echo "line $i" > "f$i.txt"; done
printf 'a\r\nb\r\n' > crlf.txt
echo node_modules/ > .gitignore
mkdir node_modules && echo cache > node_modules/c.js
git add -A && git -c user.name=t -c user.email=t@t commit -qm init

# Pre-existing untracked file and user staging.
echo "secret-local" > .env.local
echo "staged change" >> f1.txt && git add f1.txt
echo "unstaged change" >> f2.txt

# E1: commit-tree with no identity configured
T=$(git write-tree)
if git commit-tree "$T" -m x >/dev/null 2>err.txt; then say E1 "commit-tree succeeded without identity"; else say E1 "commit-tree failed without identity: $(head -1 err.txt)"; fi
rm -f err.txt
export GIT_AUTHOR_NAME=hy-harness GIT_AUTHOR_EMAIL=hy@local GIT_COMMITTER_NAME=hy-harness GIT_COMMITTER_EMAIL=hy@local

# E2: add -u vs add -A in a temp index copied from .git/index
cp .git/index ../work_u.index; cp .git/index ../work_a.index; cp .git/index ../user.index
GIT_INDEX_FILE=../work_u.index git add -u
GIT_INDEX_FILE=../work_a.index git add -A
say E2 "add -u captures .env.local: $(GIT_INDEX_FILE=../work_u.index git ls-files .env.local | wc -l)"
say E2 "add -A captures .env.local: $(GIT_INDEX_FILE=../work_a.index git ls-files .env.local | wc -l)"
CK_TREE=$(GIT_INDEX_FILE=../work_a.index git write-tree)
U_TREE=$(GIT_INDEX_FILE=../work_u.index git write-tree)
CK=$(git commit-tree "$CK_TREE" -p HEAD -m ckpt) && git update-ref refs/hy/checkpoints/run1/r1 "$CK"
HEAD0=$(git rev-parse HEAD)

# Simulated round: modify untracked file, tracked file, add a new file, run git add.
sleep 1.1
echo "worker edit" >> .env.local
echo "worker edit" >> f3.txt
echo new > new.txt
git add new.txt
M_F10=$(mtime f10.txt); M_NM=$(mtime node_modules/c.js)

# E3: Rev 2 rollback (read-tree into real index + checkout-index -f -a) on a copy
cp -r . ../rev2copy 2>/dev/null
( cd ../rev2copy && sleep 1.1 && git read-tree "$U_TREE" && git checkout-index -f -a \
  && say E3 "rev2: .env.local restored: $(grep -q worker .env.local && echo no || echo yes)" \
  && say E3 "rev2: f10 mtime changed: $([ "$(mtime f10.txt)" != "$M_F10" ] && echo yes || echo no)" \
  && say E3 "rev2: user staged f1 still differs from HEAD in index: $(git diff --cached --quiet HEAD -- f1.txt && echo no || echo yes)" \
  && say E3 "rev2: f2 unstaged change became staged: $(git diff --quiet -- f2.txt && echo yes || echo no)" )

# E4: Rev 3 rollback (diff-tree + checkout-index of changed paths + restore user index)
sleep 1.1
cp ../user.index ../cur.index
GIT_INDEX_FILE=../cur.index git add -A
CUR_TREE=$(GIT_INDEX_FILE=../cur.index git write-tree)
CHANGES=$(git diff-tree -r --no-renames --name-status "$CK_TREE" "$CUR_TREE")
say E4 "diff-tree changes: $(echo "$CHANGES" | tr '\n\t' '; ')"
GIT_INDEX_FILE=../rb.index git read-tree "$CK_TREE"
echo "$CHANGES" | awk '$1=="M"||$1=="D"{print $2}' | GIT_INDEX_FILE=../rb.index git checkout-index -f --stdin
echo "$CHANGES" | awk '$1=="A"{print $2}' | while read -r p; do rm -f -- "$p"; done
cp ../user.index .git/index
say E4 ".env.local restored: $(grep -q worker .env.local && echo no || echo yes)"
say E4 "f3 restored: $(grep -q worker f3.txt && echo no || echo yes)"
say E4 "new.txt deleted: $([ -e new.txt ] && echo no || echo yes)"
say E4 "f10 mtime unchanged: $([ "$(mtime f10.txt)" = "$M_F10" ] && echo yes || echo no)"
say E4 "node_modules untouched: $([ "$(mtime node_modules/c.js)" = "$M_NM" ] && echo yes || echo no)"
say E4 "user staged f1 preserved: $(git diff --cached --quiet HEAD -- f1.txt && echo no || echo yes)"
say E4 "f2 still unstaged: $(git diff --quiet -- f2.txt && echo no || echo yes)"
say E4 "HEAD unchanged: $([ "$(git rev-parse HEAD)" = "$HEAD0" ] && echo yes || echo no)"

# E5: byte-exact storage with autocrlf=true, with and without GIT_ATTR_SOURCE/autocrlf override
printf 'x\r\ny\r\n' > crlf2.txt
cp .git/index ../e5a.index; cp .git/index ../e5b.index
GIT_INDEX_FILE=../e5a.index git add crlf2.txt 2>/dev/null
GIT_INDEX_FILE=../e5b.index GIT_ATTR_SOURCE=$EMPTY_TREE git -c core.autocrlf=false -c core.safecrlf=false add crlf2.txt
A=$(GIT_INDEX_FILE=../e5a.index git ls-files -s crlf2.txt | awk '{print $2}')
B=$(GIT_INDEX_FILE=../e5b.index git ls-files -s crlf2.txt | awk '{print $2}')
RAW=$(git hash-object --no-filters crlf2.txt)
say E5 "default config stores raw bytes: $([ "$A" = "$RAW" ] && echo yes || echo no)"
say E5 "GIT_ATTR_SOURCE+autocrlf=false stores raw bytes: $([ "$B" = "$RAW" ] && echo yes || echo no)"
echo "git: $(git --version)"
