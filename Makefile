# Releasing the pair. Running the project (dev server, demos, compose) is web/Makefile; this file only
# exists because a release has an ORDER that nothing in package.json enforces: three-slicer pins
# three-slicer-viewer exactly, so the viewer must reach the registry first or three-slicer@x.y.z cannot be
# installed at all, and the MIT mirror must be pushed after so it shows the code that was published.
#
#   make bump V=0.3.0        set both packages, the pin and the demo app's pins, then check the lockstep
#   make publish             preflight (clean tree on a pushed main, tests, tarball check) -> publish
#                            viewer -> publish three-slicer -> sync the mirror -> tag vX.Y.Z and push it
#   make publish DRY=1       the same with `npm publish --dry-run`, no git checks, no tag, no mirror push
VERSION       := $(shell node -p "require('./packages-mit/package.json').version")
VIEWER_REMOTE ?= https://github.com/kimgh06/three-slicer-viewer.git
DRY           ?= 0
NPM_PUBLISH   := npm publish $(if $(filter 1,$(DRY)),--dry-run,)

.PHONY: bump preflight publish

bump:  ## set three-slicer, three-slicer-viewer, the pin and the demo app's pins to V=x.y.z
	@test -n "$(V)" || { echo "usage: make bump V=0.3.0"; exit 1; }
	@node -e ' \
	  const fs = require("fs"); \
	  const edit = (path, fn) => { const pkg = JSON.parse(fs.readFileSync(path, "utf8")); fn(pkg); fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n") }; \
	  edit("packages-mit/package.json", p => { p.version = "$(V)" }); \
	  edit("packages/package.json", p => { p.version = "$(V)"; p.dependencies["three-slicer-viewer"] = "$(V)" }); \
	  edit("web/viewer/package.json", p => { p.dependencies["three-slicer"] = "$(V)"; p.dependencies["three-slicer-viewer"] = "$(V)" }); \
	  console.log("bumped both packages and the pin to $(V)")'
	@npm i --package-lock-only --no-audit --no-fund >/dev/null
	@node packages-mit/tests/test_version_lockstep.mjs >/dev/null && echo "lockstep ok"

preflight:  ## everything that must hold before a publish; DRY=1 skips the git-state checks
	@grep -q "^## $(VERSION)" packages/CHANGELOG.md || { echo "packages/CHANGELOG.md has no '## $(VERSION)' entry"; exit 1; }
ifneq ($(DRY),1)
	@git diff --quiet && git diff --cached --quiet || { echo "working tree is not clean"; exit 1; }
	@[ "$$(git branch --show-current)" = main ] || { echo "publish from main (on $$(git branch --show-current))"; exit 1; }
	@git fetch -q origin && [ "$$(git rev-parse HEAD)" = "$$(git rev-parse origin/main)" ] || { echo "main is not pushed to origin"; exit 1; }
	@! git rev-parse -q --verify "refs/tags/v$(VERSION)" >/dev/null || { echo "tag v$(VERSION) already exists"; exit 1; }
	@npm whoami >/dev/null 2>&1 || { echo "not logged in to npm (npm login)"; exit 1; }
endif
	npm test
	npm run build
	bash packages/pack_check.sh

publish: preflight  ## release $(VERSION): viewer first, then three-slicer, then the mirror and the tag
	cd packages-mit && $(NPM_PUBLISH)
	cd packages && $(NPM_PUBLISH)
ifeq ($(DRY),1)
	@echo "[dry] skipped: mirror sync, tag v$(VERSION), push"
else
	$(MAKE) -C web sync-viewer VIEWER_REMOTE=$(VIEWER_REMOTE)
	git tag -a "v$(VERSION)" -m "three-slicer + three-slicer-viewer $(VERSION)"
	git push origin "v$(VERSION)"
	@echo "released $(VERSION)"
endif
