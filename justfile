default: build

build:
    npm run build

binary:
    npm run binary

test:
    npm test

check:
    npm run check

smoke:
    npm run smoke

run *ARGS:
    npm run dev -- {{ARGS}}
