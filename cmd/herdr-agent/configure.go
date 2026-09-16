package main

import (
	"context"
	"fmt"

	"github.com/hewenyu/herdr-agent/internal/bridge"
	"github.com/hewenyu/herdr-agent/internal/projects"
	"github.com/hewenyu/herdr-agent/internal/projectweb"
)

const defaultConfigListen = "127.0.0.1:18790"

// configure works before Feishu onboarding or herdr startup. Sharing serve's
// state lock prevents a second catalog writer from overwriting live settings.
func cmdConfigure(ctx context.Context, d *deps, args []string) error {
	fs := newFlags(d, "configure", "[--listen 127.0.0.1:18790] [--open]")
	addr := fs.String("listen", defaultConfigListen, "local configuration address (loopback IP only)")
	open := fs.Bool("open", false, "open the configuration page in the browser")
	if err := parseFlags(fs, args); err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return usagef("configure takes no positional arguments")
	}
	if d.StateDir == "" {
		return usagef("configure requires a state directory")
	}
	lock, err := bridge.AcquireInstanceLock(d.StateDir)
	if err != nil {
		return fmt.Errorf("本地服务已运行或配置目录被占用，请打开已运行服务的配置页面（默认 http://%s/）；不要启动第二个配置服务: %w", defaultConfigListen, err)
	}
	defer lock.Release()
	catalog, err := projects.Open(d.StateDir, d.Cfg.Tasks)
	if err != nil {
		return err
	}
	return projectweb.Serve(ctx, *addr, catalog, func(url string) {
		fmt.Fprintf(d.Out, "本地项目配置：%s\n保存后新任务使用最新目录和 Bypass 设置。\n", url)
		if *open && d.OpenURL != nil {
			if err := d.OpenURL(url); err != nil {
				fmt.Fprintf(d.Err, "无法自动打开浏览器，请使用上面的地址：%v\n", err)
			}
		}
	})
}
