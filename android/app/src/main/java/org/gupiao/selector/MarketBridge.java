package org.gupiao.selector;

import android.content.Context;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import okhttp3.Call;
import okhttp3.OkHttpClient;
import okhttp3.Protocol;
import okhttp3.Request;
import okhttp3.Response;

public class MarketBridge {
    private final Context context;
    private final WebView webView;
    private final OkHttpClient client = new OkHttpClient.Builder()
            .retryOnConnectionFailure(true)
            .protocols(Collections.singletonList(Protocol.HTTP_1_1))
            .build();
    private final ExecutorService executor = Executors.newFixedThreadPool(4);
    private final ConcurrentHashMap<String, Call> calls = new ConcurrentHashMap<>();

    public MarketBridge(Context context, WebView webView) {
        this.context = context;
        this.webView = webView;
    }

    @JavascriptInterface
    public void get(String url, String requestId) {
        if (url == null || requestId == null ||
                !(url.startsWith("https://") || url.startsWith("http://"))) {
            resolve(requestId, false, "无效的行情请求地址");
            return;
        }
        executor.execute(() -> {
            Call call = client.newCall(new Request.Builder()
                    .url(url)
                    .header("User-Agent", "Mozilla/5.0 (Android) AppleWebKit/537.36")
                    .header("Referer", "https://quote.eastmoney.com/center/gridlist.html")
                    .build());
            calls.put(requestId, call);
            try (Response response = call.execute()) {
                String body = response.body() == null ? "" : response.body().string();
                resolve(requestId, response.isSuccessful(), body);
            } catch (IOException exception) {
                resolve(requestId, false, exception.getMessage() == null ? "网络请求失败" : exception.getMessage());
            } finally {
                calls.remove(requestId);
            }
        });
    }

    @JavascriptInterface
    public void cancel(String requestId) {
        Call call = calls.remove(requestId);
        if (call != null) {
            call.cancel();
        }
    }

    @JavascriptInterface
    public void saveFile(String filename, String content, String requestId) {
        executor.execute(() -> {
            try {
                String safeName = new File(filename == null ? "result.csv" : filename).getName();
                File file = new File(context.getFilesDir(), safeName);
                try (FileOutputStream output = new FileOutputStream(file)) {
                    output.write((content == null ? "" : content).getBytes(StandardCharsets.UTF_8));
                }
                resolve(requestId, true, file.getAbsolutePath());
            } catch (IOException exception) {
                resolve(requestId, false, exception.getMessage() == null ? "文件保存失败" : exception.getMessage());
            }
        });
    }

    public void cancelAll() {
        for (Call call : calls.values()) {
            call.cancel();
        }
        calls.clear();
        executor.shutdownNow();
    }

    private void resolve(String requestId, boolean success, String body) {
        String script = "window.__marketResolve(" + quote(requestId) + "," +
                success + "," + quote(body) + ");";
        webView.post(() -> webView.evaluateJavascript(script, null));
    }

    private String quote(String value) {
        return JSONObject.quote(value == null ? "" : value);
    }
}
