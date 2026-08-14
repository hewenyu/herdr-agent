package setup

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	larksdk "github.com/larksuite/oapi-sdk-go/v3"
	larkcore "github.com/larksuite/oapi-sdk-go/v3/core"
)

// nameTimeout bounds the identity lookup.
//
// It is short and its failure is not fatal: the run continues without a name.
// A command whose next act is to wait on a human must not spend the human's
// attention on a REST call that is going nowhere.
const nameTimeout = 10 * time.Second

// botInfoPath is the endpoint that answers what an app is CALLED.
//
// It is not in the generated SDK surface (the channel module reaches it with a
// raw Get for the same reason), but it is the answer to the question this
// command used to guess at: during the run that motivated this file,
// app_name="herdr-agent-e1" was sitting in the SDK debug log while the tool was
// telling its user to look for a bot named herdr-agent.
const botInfoPath = "/open-apis/bot/v3/info"

// fetchAppName asks Feishu what an app is called.
//
// Behind a variable so the whole flow can be driven without a network. The
// error is for a human to read, never to act on: every caller degrades to "the
// name could not be fetched" and prints the id instead of inventing a name.
var fetchAppName = func(ctx context.Context, appID, appSecret string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, nameTimeout)
	defer cancel()

	// LogLevelWarn: this client exists for one GET, and larkcore's default
	// logger writes to os.Stdout (core/logger.go), which is the stream the CLI
	// keeps its payload on. The run also holds a stdout capture open, so a line
	// escaping here is untidy rather than wrong.
	//
	// The http client carries its own deadline as well as the context's: the
	// SDK builds requests with the context, but a client with no timeout of its
	// own is one dependency upgrade away from ignoring it.
	client := larksdk.NewClient(appID, appSecret,
		larksdk.WithLogLevel(larkcore.LogLevelWarn),
		larksdk.WithHttpClient(&http.Client{Timeout: nameTimeout}),
	)

	// The errors below carry no "setup:" prefix and do not repeat the app id: they
	// are never returned to a caller, only rendered into a sentence that already
	// says which app it is about ("name unavailable: <reason>").
	resp, err := client.Get(ctx, botInfoPath, nil, larkcore.AccessTokenTypeTenant)
	if err != nil {
		return "", fmt.Errorf("bot/v3/info: %w", err)
	}
	if resp == nil {
		return "", errors.New("bot/v3/info returned nothing")
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("bot/v3/info returned HTTP %d", resp.StatusCode)
	}

	var body struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
		Bot  struct {
			AppName string `json:"app_name"`
			OpenID  string `json:"open_id"`
		} `json:"bot"`
	}
	if err := json.Unmarshal(resp.RawBody, &body); err != nil {
		return "", fmt.Errorf("parse bot/v3/info: %w", err)
	}
	if body.Code != 0 {
		// The message is Feishu's own and is the useful half: an app whose bot
		// capability is off answers here, and so does a wrong secret.
		return "", fmt.Errorf("bot/v3/info: code %d %s", body.Code, body.Msg)
	}
	if body.Bot.AppName == "" {
		return "", errors.New("bot/v3/info returned no app name")
	}
	return body.Bot.AppName, nil
}

// appName resolves a candidate's name, or reports why it could not.
//
// The failure is returned as text rather than an error because it is destined
// for a sentence a human reads while choosing between two apps: "name
// unavailable: <reason>" is answerable, and a name we made up is not.
func (r *Runner) appName(ctx context.Context, rep *reporter, c candidate) (name, problem string) {
	if !c.complete() {
		// No secret for this app on this machine, so there is no way to ask.
		// Nothing failed; there is simply nothing to ask WITH.
		return "", "no secret for it on this machine"
	}
	rep.useSecret(c.Secret)
	name, err := fetchAppName(ctx, c.AppID, c.Secret)
	if err != nil {
		return "", rep.errText(err)
	}
	return name, ""
}
