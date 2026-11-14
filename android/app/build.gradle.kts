plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "net.noluck.ergtv"
    compileSdk = 35

    defaultConfig {
        applicationId = "net.noluck.ergtv"
        minSdk = 26
        targetSdk = 34
        versionCode = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()
        versionName = "1.0." + (System.getenv("GITHUB_RUN_NUMBER") ?: "0")
    }

    // One fixed debug key, checked in, so every CI build installs over the
    // last one. (CI otherwise makes a fresh key per run, and Android refuses
    // an update signed with a different key.) It's a sideloaded personal
    // app, so a public debug key is fine; it protects nothing.
    signingConfigs {
        getByName("debug") {
            storeFile = rootProject.file("erg-tv-debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    buildTypes {
        getByName("debug") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    // The display itself is the web app in ../../tv, bundled into the APK so
    // it opens instantly and works offline.
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("webassets"))
}

val copyWeb by tasks.registering(Copy::class) {
    from(rootProject.file("../tv")) { into("web/tv") }
    from(rootProject.file("../lib")) { into("web/lib") }
    from(rootProject.file("../ui")) { into("web/ui") }
    into(layout.buildDirectory.dir("webassets"))
}
tasks.named("preBuild") { dependsOn(copyWeb) }

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
}
