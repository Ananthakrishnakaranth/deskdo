plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// CI passes a stable signing key through env vars (from GitHub secrets) so each new APK installs
// over the previous one. Without it the build falls back to the debug key.
val releaseKeystore: String? = System.getenv("ANDROID_KEYSTORE_FILE")

android {
    namespace = "app.deskdo.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.deskdo.android"
        minSdk = 26
        targetSdk = 35
        versionCode = (System.getenv("VERSION_CODE") ?: "1").toInt()
        versionName = "1.0.${versionCode}"
    }

    signingConfigs {
        create("release") {
            if (releaseKeystore != null) {
                storeFile = file(releaseKeystore)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS") ?: "deskdo"
                keyPassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (releaseKeystore != null) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    lint {
        // Sideloaded personal app: Play Store policy checks don't apply.
        checkReleaseBuilds = false
        abortOnError = false
    }
}

dependencies {
    implementation("androidx.work:work-runtime:2.10.0")
}
