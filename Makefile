# Releasing the pair. Running the project (dev server, demos, compose) is web/Makefile; this file only
# exists because a release has an ORDER that nothing in package.json enforces: three-slicer pins
# three-slicer-viewer exactly, so the viewer must reach the registry first or three-slicer@x.y.z cannot be
# installed at all, and the MIT mirror must be pushed after so it shows the code that was published.
#
#   make bump V=0.3.0        set both packages, the pin and the demo app's pins, then check the lockstep
#   make publish             preflight (clean tree on a pushed main, tests, tarball check) -> publish
#                            viewer -> publish three-slicer -> sync the mirror -> tag vX.Y.Z and push it
#   make publish DRY=1       the same with `npm publish --dry-run`, no git checks, no tag, no mirror push
VERSION       := $(shell node -p "require('./viewer-package/package.json').version")
VIEWER_REMOTE ?= https://github.com/kimgh06/three-slicer-viewer.git
DRY           ?= 0
LOG_DIR       ?= $(or $(TMPDIR),/tmp)/three-slicer-release

# The account publishes with 2FA, so a real publish asks for a one-time code right before each upload (a code
# typed at the start would expire during the tests). --ignore-scripts skips the viewer's prepublishOnly: its build
# and its two tests are exactly what preflight has just run.
ifeq ($(DRY),1)
ASK_OTP     :=
NPM_PUBLISH := npm publish --ignore-scripts --dry-run
else
ASK_OTP     := printf 'npm OTP: '; read otp </dev/tty;
NPM_PUBLISH := npm publish --ignore-scripts --otp=$$otp
endif

# $(call step,label,command): one status line per step. The output goes to $(LOG_DIR)/<label>.log and is printed
# only when the step fails; "[  ]" is shown while it runs when stdout is a terminal. Neither argument may contain
# a comma ($(call) splits on it).
step = mkdir -p $(LOG_DIR); label='$(1)'; \
	log="$(LOG_DIR)/$$(printf '%s' "$$label" | tr -c 'A-Za-z0-9.' _).log"; \
	pad=$$(printf '%*s' $$((48 - $${\#label})) '' | tr ' ' '-'); \
	cr=''; if [ -t 1 ]; then printf '%s %s [  ]' "$$label" "$$pad"; cr='\r'; fi; \
	if ( $(2) ) >"$$log" 2>&1; then printf "$$cr%s %s [V]\n" "$$label" "$$pad"; \
	else printf "$$cr%s %s [X]\n" "$$label" "$$pad"; tail -n 40 "$$log"; echo "full log: $$log"; exit 1; fi

.PHONY: bump preflight publish

bump:  ## set three-slicer, three-slicer-viewer, the pin and the demo app's pins to V=x.y.z
	@test -n "$(V)" || { echo "usage: make bump V=0.3.0"; exit 1; }
	@node -e ' \
	  const fs = require("fs"); \
	  const edit = (path, fn) => { const pkg = JSON.parse(fs.readFileSync(path, "utf8")); fn(pkg); fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n") }; \
	  edit("viewer-package/package.json", p => { p.version = "$(V)" }); \
	  edit("packages/package.json", p => { p.version = "$(V)"; p.dependencies["three-slicer-viewer"] = "$(V)" }); \
	  edit("web/viewer/package.json", p => { p.dependencies["three-slicer"] = "$(V)"; p.dependencies["three-slicer-viewer"] = "$(V)" }); \
	  console.log("bumped both packages and the pin to $(V)")'
	@npm i --package-lock-only --no-audit --no-fund >/dev/null
	@node viewer-package/tests/test_version_lockstep.mjs >/dev/null && echo "lockstep ok"

preflight:  ## everything that must hold before a publish; DRY=1 skips the git-state checks
	@$(call step,CHANGELOG has ## $(VERSION),grep -q "^## $(VERSION)" packages/CHANGELOG.md)
ifneq ($(DRY),1)
	@$(call step,working tree is clean,git diff --quiet && git diff --cached --quiet)
	@$(call step,on main,[ "$$(git branch --show-current)" = main ])
	@$(call step,main is pushed to origin,git fetch -q origin && [ "$$(git rev-parse HEAD)" = "$$(git rev-parse origin/main)" ])
	@$(call step,tag v$(VERSION) is new,! git rev-parse -q --verify "refs/tags/v$(VERSION)")
	@$(call step,logged in to npm,npm whoami)
endif
	@$(call step,npm test,npm test)
	@$(call step,npm run build,npm run build)
	@$(call step,pack_check.sh,bash packages/pack_check.sh)

publish: preflight  ## release $(VERSION): viewer first, then three-slicer, then the mirror and the tag
	@$(ASK_OTP) $(call step,publish three-slicer-viewer@$(VERSION),cd viewer-package && $(NPM_PUBLISH))
	@$(ASK_OTP) $(call step,publish three-slicer@$(VERSION),cd packages && $(NPM_PUBLISH))
ifeq ($(DRY),1)
	@echo "[dry] skipped: mirror sync, tag v$(VERSION), push"
else
	@$(call step,sync the MIT mirror,$(MAKE) -C web sync-viewer VIEWER_REMOTE=$(VIEWER_REMOTE))
	@$(call step,tag v$(VERSION),git tag -a "v$(VERSION)" -m "three-slicer + three-slicer-viewer $(VERSION)")
	@$(call step,push tag v$(VERSION),git push origin "v$(VERSION)")
	@echo "released $(VERSION)"
endif
