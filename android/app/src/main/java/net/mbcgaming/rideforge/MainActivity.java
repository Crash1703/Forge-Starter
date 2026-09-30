package net.mbcgaming.rideforge;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own plugins register before the bridge starts.
        registerPlugin(LockScreenPlugin.class);
        super.onCreate(savedInstanceState);
        applyFontSize();
    }

    @Override
    public void onResume() {
        super.onResume();
        // The rider may have changed the phone's font size while we were away.
        applyFontSize();
    }

    /**
     * Follow the phone's font size setting, as Chrome does for the website.
     * Android WebViews ignore it unless told, so the app looked smaller than
     * the web version on phones with larger text.
     */
    private void applyFontSize() {
        if (getBridge() == null || getBridge().getWebView() == null) return;
        float scale = getResources().getConfiguration().fontScale;
        getBridge().getWebView().getSettings().setTextZoom(Math.round(scale * 100));
    }
}
