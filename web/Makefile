# Managing the web/ development processes. The port comes from .env (copy .env.example).
-include .env
export

DEV_PORT ?= 5173
UP_PORT  ?= 8080

EXAMPLES := ../examples
DEMOS    := instant-quote printer-showcase cad-embed farm-dashboard

.PHONY: dev up down logs kill pkg demos demos-install demos-clean sync-viewer

pkg:   ## rebuild both package dists — the permissive viewer first, since three-slicer/viewer wraps it at runtime
	cd .. && npm run build -w three-slicer-viewer -w three-slicer

# The demos under examples/ are standalone projects: they install three-slicer from npm, so they have
# their own node_modules and are NOT part of this repo's workspaces. Hence the explicit install.
demos-install:  ## npm i in each examples/* that has never been installed
	@for d in $(DEMOS); do \
	  if [ ! -d $(EXAMPLES)/$$d/node_modules ]; then \
	    echo "==> npm i in examples/$$d"; \
	    (cd $(EXAMPLES)/$$d && npm i --no-audit --no-fund) || exit 1; \
	  fi; \
	done

demos: demos-install  ## build examples/* into viewer/public/demos (incremental; FORCE=1 rebuilds all)
	@cd viewer && node scripts/build_demos.mjs $(if $(FORCE),--force,)

demos-clean:  ## drop the copied demo builds
	rm -rf viewer/public/demos

dev: pkg demos  ## vite dev server (DEV_PORT) with /demos ready; kills whatever holds the port first
	@$(MAKE) --no-print-directory kill PORT=$(DEV_PORT)
	@echo "==> http://localhost:$(DEV_PORT)/  ·  demos at /demos"
	cd viewer && npx vite --port $(DEV_PORT) --strictPort

# The image builds the workspaces itself (`npm ci && npm run build` at the repo root), but examples/* are
# NOT workspaces — they install three-slicer from npm — so `npm ci` never reaches them. Building them here
# and letting the image copy viewer/public/demos keeps the Dockerfile unchanged and the image free of four
# extra npm installs. Built directly with `docker compose build`, the /demos page just says "not built".
up: demos  ## start with docker compose (UP_PORT), demos included
	@$(MAKE) --no-print-directory kill PORT=$(UP_PORT)
	docker compose up -d --build

down:
	docker compose down

logs:
	docker compose logs -f

kill:  ## kill the process holding PORT=n
	@pids=$$(lsof -ti tcp:$(PORT) 2>/dev/null); \
	if [ -n "$$pids" ]; then echo "port $(PORT) in use -> kill $$pids"; kill -9 $$pids; fi

# The MIT package has a public mirror repo whose history is viewer-package/'s alone (git subtree). The monorepo
# stays the source of truth; this pushes the folder's commits there. Run it right after `npm publish` of
# three-slicer-viewer so the mirror shows the code that was published. VIEWER_REMOTE is a git URL.
VIEWER_REMOTE ?= https://github.com/kimgh06/three-slicer-viewer.git
sync-viewer:  ## push viewer-package/ history to the mirror repo (VIEWER_REMOTE)
	cd .. && git subtree push --prefix=viewer-package $(VIEWER_REMOTE) main
