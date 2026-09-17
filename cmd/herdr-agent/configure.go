package main

import (
	"context"
	"fmt"
	"path/filepath"

	"github.com/hewenyu/herdr-agent/internal/bridge"
	"github.com/hewenyu/herdr-agent/internal/config"
	"github.com/hewenyu/herdr-agent/internal/projects"
	"github.com/hewenyu/herdr-agent/internal/projectweb"
)

func configurationAddress(cfg config.Config) string {
	if cfg.UI.ConfigListen != "" {
		return cfg.UI.ConfigListen
	}
	return config.DefaultConfigListen
}

// configure works before Feishu onboarding or herdr startup. Sharing serve's
// state lock prevents a second catalog writer from overwriting live settings.
func cmdConfigure(ctx context.Context, d *deps, args []string) error {
	fs := newFlags(d, "configure", "[--listen IP:port] [--open]")
	addr := fs.String("listen", configurationAddress(d.Cfg), "local configuration address (overrides ui.config_listen; loopback IP only)")
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
		return fmt.Errorf("本地服务已运行或配置目录被占用，请使用运行中服务日志里的配置页面地址（由 [ui].config_listen 或启动参数指定）；不要启动第二个配置服务: %w", err)
	}
	defer lock.Release()
	catalog, err := projects.Open(d.StateDir, d.Cfg.Tasks)
	if err != nil {
		return err
	}
	err = projectweb.Serve(ctx, *addr, catalog, func(url string) {
		fmt.Fprintf(d.Out, "本地项目配置：%s\n保存后新任务使用最新目录和 Bypass 设置。\n", url)
		if *open && d.OpenURL != nil {
			if err := d.OpenURL(url); err != nil {
				fmt.Fprintf(d.Err, "无法自动打开浏览器，请使用上面的地址：%v\n", err)
			}
		}
	})
	if err != nil && ctx.Err() == nil {
		return fmt.Errorf("本地配置页面启动失败；检查 %s 中的 [ui].config_listen，或使用 configure --listen 指定空闲的本机端口后重试: %w", filepath.Join(d.StateDir, config.ConfigFileName), err)
	}
	return err
}
