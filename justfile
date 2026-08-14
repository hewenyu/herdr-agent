default: build

build:
    go build ./...

test:
    go test ./...

vet:
    go vet ./...

check: vet test
    gofmt -l . | (! grep .) || (echo "gofmt needed"; exit 1)

run *ARGS:
    go run ./cmd/herdr-agent {{ARGS}}
