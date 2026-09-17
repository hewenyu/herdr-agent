package tasktools

import "errors"

// ErrNotExecuted means this invocation is known to have caused no task or
// terminal effect. A model may correct its arguments and try another operation.
// Errors without this marker must be treated as potentially executed.
var ErrNotExecuted = errors.New("task operation was not executed")

type notExecutedError struct{ error }

func (e notExecutedError) Unwrap() error { return e.error }
func (e notExecutedError) Is(target error) bool {
	return target == ErrNotExecuted
}

func notExecuted(err error) error {
	if err == nil || errors.Is(err, ErrNotExecuted) {
		return err
	}
	return notExecutedError{err}
}
