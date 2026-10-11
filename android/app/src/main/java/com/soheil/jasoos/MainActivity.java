package com.soheil.jasoos;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.Window;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

// یه WebView ساده که سایت بازی رو باز می‌کنه و اجازه‌ی میکروفون رو برای چت صوتی می‌ده.
public class MainActivity extends Activity {
    private static final int REQ_MIC = 7;
    private static final String BG = "#0e1540";

    private WebView web;
    private PermissionRequest pending;
    private String site;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        site = getString(R.string.site_url);

        Window w = getWindow();
        w.setStatusBarColor(Color.parseColor(BG));
        w.setNavigationBarColor(Color.parseColor(BG));

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor(BG));
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUserAgentString(s.getUserAgentString() + " JasoosApp");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (isOurSite(u)) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) view.loadDataWithBaseURL(site, offlinePage(), "text/html", "utf-8", null);
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest req) {
                runOnUiThread(() -> {
                    boolean audio = false;
                    for (String r : req.getResources()) if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) audio = true;
                    if (!audio) { req.deny(); return; }
                    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        req.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
                    } else {
                        pending = req;
                        requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, REQ_MIC);
                    }
                });
            }
        });

        if (state != null) web.restoreState(state);
        else web.loadUrl(startUrl(getIntent()));
    }

    private boolean isOurSite(Uri u) {
        Uri base = Uri.parse(site);
        return u != null && u.getHost() != null && u.getHost().equals(base.getHost());
    }

    private String startUrl(Intent i) {
        Uri d = i != null ? i.getData() : null;
        return isOurSite(d) ? d.toString() : site;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        Uri d = intent.getData();
        if (isOurSite(d)) web.loadUrl(d.toString());
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        super.onRequestPermissionsResult(code, perms, results);
        if (code != REQ_MIC || pending == null) return;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) {
            pending.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
        } else {
            pending.deny();
        }
        pending = null;
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }

    private String offlinePage() {
        return "<!doctype html><html lang='fa' dir='rtl'><head><meta name='viewport' content='width=device-width,initial-scale=1'>"
            + "<style>body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;"
            + "background:#0e1540;color:#eceefa;font-family:sans-serif;text-align:center;padding:24px;box-sizing:border-box}"
            + "h1{color:#f3d567;font-size:44px;margin:0 0 8px}p{color:#b9c1ea;font-size:17px;line-height:1.7}"
            + "a{margin-top:16px;background:#d4152f;color:#fff;text-decoration:none;font-weight:bold;padding:14px 32px;border-radius:16px;font-size:18px}</style></head>"
            + "<body><h1>جاسوس</h1><p>به اینترنت وصل نشد.<br>اینترنت یا فیلترشکن رو چک کن.</p>"
            + "<a href='" + site + "'>دوباره امتحان کن</a></body></html>";
    }
}
