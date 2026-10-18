package io.github.mist1494732214.ziisan;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * 籽三 · 手机学习库（安卓壳）
 *
 * 这是个**极薄的壳**：只做三件事 ——
 *   1. 用 WebView 打开 https://mist1494732214.github.io/ziisan-app/（页面本身就是完整的 App）
 *   2. 打开 localStorage / IndexedDB / Service Worker（离线缓存全靠它们）
 *   3. 站外链接（GitHub 登录页、令牌页面等）交给系统浏览器，App 内部不乱跳
 *
 * 为什么用 WebView 壳而不是 TWA：这个壳不依赖 Chrome、不依赖 assetlinks.json，
 * 构建稳定、装完就能用。代价是引擎跟着系统 WebView 走（安卓 7+ 都够用）。
 */
public class MainActivity extends Activity {

    private static final String HOME = "https://mist1494732214.github.io/ziisan-app/";
    private WebView web;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        askCameraPermission();

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // localStorage：令牌与设置存这里
        s.setDatabaseEnabled(true);            // WebSQL/IndexedDB 兼容位
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);

        // 扫码登录要在 WebView 里取相机流：必须放行 PermissionRequest 的 VIDEO_CAPTURE
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(new Runnable() {
                    @Override public void run() { request.grant(request.getResources()); }
                });
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                String host = u.getHost() == null ? "" : u.getHost();
                // 站内（含 GitHub API 与 GitHub 登录/令牌页）留在 WebView；其它交给系统浏览器
                if (host.endsWith("github.io") || host.equals("api.github.com")
                        || host.equals("github.com")) {
                    return false;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Exception ignored) {
                }
                return true;
            }
        });

        web.loadUrl(HOME);
        setContentView(web, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    /** 申请相机权限（API 23+ 是运行时权限；拒绝也不崩，只是扫码用不了） */
    private void askCameraPermission() {
        if (Build.VERSION.SDK_INT < 23) return;
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.CAMERA}, 1001);
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        super.onRequestPermissionsResult(code, perms, results);
        // 授权结果不用处理：页面里点「扫码登录」时若没权限，会给出提示
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            ((ViewGroup) web.getParent()).removeView(web);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
