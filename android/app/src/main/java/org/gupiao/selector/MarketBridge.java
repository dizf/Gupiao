package org.gupiao.selector;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.os.Build;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

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
    private static final String NOTIFICATION_CHANNEL_ID = "screening_matches";
    private final Context context;
    private final WebView webView;
    private final OkHttpClient client = new OkHttpClient.Builder()
            .retryOnConnectionFailure(true)
            .protocols(Collections.singletonList(Protocol.HTTP_1_1))
            .build();
    private final ExecutorService executor = Executors.newFixedThreadPool(4);
    private final ConcurrentHashMap<String, Call> calls = new ConcurrentHashMap<>();

    public MarketBridge(Context context, WebView webView) {
        this.context = context.getApplicationContext();
        this.webView = webView;
        createNotificationChannel();
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
    public void notifyMatch(String title, String message) {
        if (Build.VERSION.SDK_INT >= 33 &&
                context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                        != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        NotificationCompat.Builder builder = new NotificationCompat.Builder(
                context, NOTIFICATION_CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title == null ? "实时监控命中" : title)
                .setContentText(message == null ? "" : message)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(message == null ? "" : message))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_REMINDER)
                .setAutoCancel(true)
                .setDefaults(NotificationCompat.DEFAULT_ALL);
        NotificationManagerCompat.from(context).notify(
                (title + message).hashCode(), builder.build());
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

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < 26) {
            return;
        }
        NotificationManager manager =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
                NOTIFICATION_CHANNEL_ID, "选股实时提醒", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("实时监控命中股票时提醒");
        channel.enableVibration(true);
        channel.setSound(
                Settings.System.DEFAULT_NOTIFICATION_URI,
                new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                        .build());
        manager.createNotificationChannel(channel);
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
