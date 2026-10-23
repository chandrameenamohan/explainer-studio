.PHONY: check typecheck unit e2e learn start
check: typecheck unit
typecheck:
	npx tsc --noEmit
unit:
	npm test --silent
e2e:
	npm run e2e --silent
learn:
	npm run learn --silent
start:
	npm start --silent
