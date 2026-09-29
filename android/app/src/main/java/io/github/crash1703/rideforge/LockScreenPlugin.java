package io.github.crash1703.rideforge;

import android.app.Activity;
import android.os.Build;
import android.view.WindowManager;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Ride mode on the lock screen, as Google Maps does while navigating: when
 * the screen wakes during a ride, the ride view shows straight away without
 * unlocking. Only while a ride is on; the phone's lock works as normal
 * otherwise, and anything beyond the ride view still needs unlocking.
 */
@CapacitorPlugin(name = "LockScreen")
public class LockScreenPlugin extends Plugin {

    @PluginMethod
    public void set(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        Activity activity = getActivity();
        activity.runOnUiThread(() -> {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                activity.setShowWhenLocked(on);
            } else if (on) {
                activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED);
            } else {
                activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED);
            }
            call.resolve();
        });
    }
}
