package com.fulens.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.res.AssetManager;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.view.WindowInsets;
import android.webkit.ServiceWorkerClient;
import android.webkit.ConsoleMessage;
import android.webkit.ServiceWorkerController;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import android.util.Log;

public final class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final int PICK_IMAGE = 100;
    private WebView web;
    private ValueCallback<Uri[]> imageCallback;
    private boolean takingPhoto;

    /** All document, module, WASM, model and service-worker requests use APK assets. */
    private static final class LocalAssets {
        private final AssetManager assets;
        LocalAssets(AssetManager assets) { this.assets = assets; }

        WebResourceResponse respond(WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (!"https".equals(uri.getScheme()) || !HOST.equals(uri.getHost())) return error(403, "Forbidden", "");
            String path = uri.getPath();
            if (path == null || path.contains("..") || path.contains("\\")) return error(404, "Not Found", "");
            if (path.startsWith("/api/")) {
                return error(503, "Unavailable", "{\"error\":\"APK has no server fallback; see the local model error.\"}");
            }
            if (!"GET".equals(request.getMethod())) return error(405, "Method Not Allowed", "");
            if (path.equals("/")) path = "/index.html";
            String mime = path.endsWith(".js") || path.endsWith(".mjs") ? "text/javascript"
                : path.endsWith(".wasm") ? "application/wasm"
                : path.endsWith(".onnx") ? "application/octet-stream"
                : path.endsWith(".css") ? "text/css"
                : path.endsWith(".svg") ? "image/svg+xml"
                : path.endsWith(".png") ? "image/png"
                : path.endsWith(".webmanifest") ? "application/manifest+json" : "text/html";
            try {
                return new WebResourceResponse(mime, "UTF-8", 200, "OK",
                    Collections.singletonMap("Cache-Control", "no-cache"), assets.open("public" + path));
            } catch (Exception error) { return error(404, "Not Found", ""); }
        }

        private WebResourceResponse error(int status, String reason, String message) {
            return new WebResourceResponse("application/json", "UTF-8", status, reason, null,
                new ByteArrayInputStream(message.getBytes(StandardCharsets.UTF_8)));
        }
    }

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        LocalAssets local = new LocalAssets(getApplicationContext().getAssets());
        ServiceWorkerController.getInstance().setServiceWorkerClient(new ServiceWorkerClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                return local.respond(request);
            }
        });
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xfff4f1e9);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                Insets safe = insets.getInsets(WindowInsets.Type.systemBars()
                    | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
            } else {
                view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            }
            return insets;
        });
        web = new WebView(this);
        web.setBackgroundColor(0xfff4f1e9);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        // Only the separate debug package opts in; release builds keep this disabled.
        WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return local.respond(request);
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                return !"https".equals(uri.getScheme()) || !HOST.equals(uri.getHost());
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage message) {
                if (message.messageLevel() == ConsoleMessage.MessageLevel.ERROR
                    || message.messageLevel() == ConsoleMessage.MessageLevel.WARNING) {
                    Log.w("FuLens", message.message() + " (" + message.sourceId() + ":" + message.lineNumber() + ")");
                }
                return true;
            }
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                                       FileChooserParams parameters) {
                if (imageCallback != null) imageCallback.onReceiveValue(null);
                imageCallback = callback;
                takingPhoto = parameters.isCaptureEnabled();
                try {
                    Intent intent;
                    if (takingPhoto) {
                        intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
                        Uri captureUri = CaptureProvider.uriFor(MainActivity.this);
                        try (OutputStream image = getContentResolver().openOutputStream(captureUri, "wt")) {
                            intent.putExtra(MediaStore.EXTRA_OUTPUT, captureUri);
                            intent.setClipData(ClipData.newRawUri("capture", captureUri));
                            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                        }
                    } else {
                        intent = new Intent(Intent.ACTION_GET_CONTENT).setType("image/*")
                            .addCategory(Intent.CATEGORY_OPENABLE);
                    }
                    startActivityForResult(intent, PICK_IMAGE);
                } catch (Exception error) {
                    imageCallback.onReceiveValue(null);
                    imageCallback = null;
                    Toast.makeText(MainActivity.this, "\u65e0\u6cd5\u6253\u5f00\u76f8\u673a\u6216\u76f8\u518c", Toast.LENGTH_LONG).show();
                }
                return true;
            }
        });
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);
        web.loadUrl("https://" + HOST + "/?apk=5");
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != PICK_IMAGE || imageCallback == null) return;
        Uri[] chosen = null;
        if (result == RESULT_OK) {
            if (takingPhoto && new File(getCacheDir(), "capture.jpg").length() > 0) chosen = new Uri[]{CaptureProvider.uriFor(this)};
            else if (data != null && data.getData() != null) chosen = new Uri[]{data.getData()};
            else if (data != null && data.getClipData() != null && data.getClipData().getItemCount() > 0)
                chosen = new Uri[]{data.getClipData().getItemAt(0).getUri()};
        }
        imageCallback.onReceiveValue(chosen);
        imageCallback = null;
    }

    @Override public void onBackPressed() {
        String dismiss = "(function(){var pairs=[['cropBackdrop','cropCancelButton'],"
            + "['capturePickerBackdrop','capturePickerCancel'],['winPickerBackdrop','winPickerClose']];"
            + "for(var p of pairs){var e=document.getElementById(p[0]);if(e&&!e.hidden){document.getElementById(p[1]).click();return true}}"
            + "return false})()";
        web.evaluateJavascript(dismiss, closed -> {
            if (!"true".equals(closed)) { if (web.canGoBack()) web.goBack(); else finish(); }
        });
    }

    @Override protected void onDestroy() {
        if (imageCallback != null) imageCallback.onReceiveValue(null);
        web.destroy();
        new File(getCacheDir(), "capture.jpg").delete();
        super.onDestroy();
    }
}
