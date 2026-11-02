plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
  id("org.jetbrains.kotlin.plugin.serialization")
  id("org.jetbrains.kotlin.plugin.compose")
}

android {
  namespace = "ai.openclaw.clawsense"
  testBuildType = providers.gradleProperty("clawsenseTestBuildType").orElse("debug").get()
  compileSdk = 36

  defaultConfig {
    applicationId = "ai.openclaw.clawsense"
    minSdk = 29
    targetSdk = 34
    versionCode = 16
    versionName = "0.3.12-upstream-device-preview"

    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    vectorDrawables.useSupportLibrary = true
  }

  buildTypes {
    debug {
      applicationIdSuffix = ".debug"
      versionNameSuffix = "-debug"
      manifestPlaceholders["appLabel"] = "ClawSense Dev"
    }
    create("livePreview") {
      initWith(getByName("debug"))
      applicationIdSuffix = ".livepreview"
      versionNameSuffix = "-live-preview"
      manifestPlaceholders["appLabel"] = "ClawSense Live"
      signingConfig = signingConfigs.getByName("debug")
      matchingFallbacks += listOf("debug")
    }
    release {
      isMinifyEnabled = false
      manifestPlaceholders["appLabel"] = "ClawSense"
      proguardFiles(
        getDefaultProguardFile("proguard-android-optimize.txt"),
        "proguard-rules.pro",
      )
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }


  buildFeatures {
    compose = true
    buildConfig = true
  }


  packaging {
    resources {
      excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
  }
}

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

dependencies {
  implementation("ai.pipecat:small-webrtc-transport:1.2.2")
  val composeBom = platform("androidx.compose:compose-bom:2024.09.03")

  implementation(composeBom)
  androidTestImplementation(composeBom)

  implementation("androidx.core:core-ktx:1.13.1")
  implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.6")
  implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.6")
  implementation("androidx.lifecycle:lifecycle-service:2.8.6")
  implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.6")
  implementation("androidx.activity:activity-compose:1.9.2")
  implementation("com.google.android.material:material:1.12.0")
  implementation("androidx.compose.ui:ui")
  implementation("androidx.compose.ui:ui-tooling-preview")
  implementation("androidx.compose.material3:material3")
  implementation("androidx.compose.material:material-icons-extended")
  implementation("androidx.work:work-runtime-ktx:2.9.1")
  implementation("androidx.security:security-crypto:1.1.0-alpha06")
  implementation("androidx.camera:camera-core:1.4.1")
  implementation("androidx.camera:camera-camera2:1.4.1")
  implementation("androidx.camera:camera-lifecycle:1.4.1")
  implementation("androidx.camera:camera-view:1.4.1")
  implementation("androidx.camera:camera-video:1.4.1")
  implementation("com.google.mlkit:barcode-scanning:17.3.0")
  implementation("com.google.mlkit:text-recognition-chinese:16.0.1")
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
  implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")
  implementation("com.squareup.okhttp3:okhttp:4.12.0")
  testImplementation("junit:junit:4.13.2")
  androidTestImplementation("androidx.test:runner:1.6.2")
  androidTestImplementation("androidx.test.ext:junit:1.2.1")
  androidTestImplementation("androidx.compose.ui:ui-test-junit4")
  // Android 16 removed InputManager.getInstance; fixed in Espresso 3.7.
  androidTestImplementation("androidx.test.espresso:espresso-core:3.7.0")

  debugImplementation("androidx.compose.ui:ui-tooling")
  debugImplementation("androidx.compose.ui:ui-test-manifest")
}
