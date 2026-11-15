# R8 / ProGuard rules for UniChat (release builds: minifyEnabled true).
# Capacitor ships its own consumer rules; the rules below cover what is app-specific.

# Keep line numbers for readable crash reports (the mapping.txt in the AAB deobfuscates them in Play Console).
-keepattributes SourceFile,LineNumberTable,*Annotation*,Signature,InnerClasses,EnclosingMethod
-renamesourcefileattribute SourceFile

# JNI: native-lib.cpp registers Java_app_unimsg_android_node_NodeRuntime_nativeStart by NAME. Renaming the class or method breaks it.
-keep class app.unimsg.android.node.NodeRuntime { native <methods>; }
-keepclasseswithmembernames class * { native <methods>; }

# Capacitor plugin discovery is reflective (@CapacitorPlugin class, @PluginMethod methods) and plugins are registered by class.
-keep class app.unimsg.android.UnimsgPlugin { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin public class * { @com.getcapacitor.annotation.PermissionCallback <methods>; @com.getcapacitor.annotation.ActivityCallback <methods>; @com.getcapacitor.PluginMethod public <methods>; }
-keep public class * extends com.getcapacitor.Plugin
-keep class com.getcapacitor.** { *; }
-dontwarn com.getcapacitor.**

# Components referenced from the manifest are kept by AAPT2's generated rules; listed explicitly so a manifest edit cannot silently drop them.
-keep class app.unimsg.android.node.NodeService
-keep class app.unimsg.android.node.BootReceiver
-keep class app.unimsg.android.node.NotificationActionReceiver

# androidx.webkit (WebMessageListener / document-start script) uses reflection into the WebView support library boundary interfaces.
-keep class androidx.webkit.** { *; }
-dontwarn org.chromium.support_lib_boundary.**
-keep class org.chromium.support_lib_boundary.** { *; }

# Cordova bridge classes (capacitor-cordova-android-plugins)
-keep class org.apache.cordova.** { *; }
-dontwarn org.apache.cordova.**
