import net.fabricmc.loom.api.LoomGradleExtensionAPI
import org.gradle.api.plugins.BasePluginExtension
import org.gradle.api.plugins.JavaPluginExtension
import org.gradle.api.tasks.testing.Test
import org.gradle.jvm.toolchain.JavaLanguageVersion
import org.gradle.language.jvm.tasks.ProcessResources

plugins {
  id("fabric-loom") version "1.10.5" apply false
}

project(":mod-fabric") {
  apply(plugin = "fabric-loom")
  apply(plugin = "java")

  val modVersion = property("mod_version").toString()
  version = modVersion
  group = property("maven_group").toString()

  val loom = extensions.getByType<LoomGradleExtensionAPI>()
  extensions.configure<BasePluginExtension> {
    archivesName.set(property("archives_base_name") as String)
  }
  extensions.configure<JavaPluginExtension> {
    toolchain.languageVersion.set(JavaLanguageVersion.of(21))
  }

  repositories {
    mavenCentral()
    maven("https://maven.fabricmc.net/")
    maven("https://dl.cloudsmith.io/public/geckolib3/geckolib/maven/")
  }

  dependencies {
    add("mappings", loom.officialMojangMappings())
    add("minecraft", "com.mojang:minecraft:${property("minecraft_version")}")
    add("modImplementation", "net.fabricmc:fabric-loader:${property("fabric_loader_version")}")
    add("modImplementation", "net.fabricmc.fabric-api:fabric-api:${property("fabric_api_version")}")
    add("modImplementation", "software.bernie.geckolib:geckolib-fabric-1.21.5:${property("geckolib_version")}")
    add("testImplementation", platform("org.junit:junit-bom:5.12.2"))
    add("testImplementation", "org.junit.jupiter:junit-jupiter")
    add("testRuntimeOnly", "org.junit.platform:junit-platform-launcher")
  }

  tasks.withType<Test>().configureEach {
    useJUnitPlatform()
  }

  tasks.named<ProcessResources>("processResources") {
    inputs.property("version", modVersion)
    filesMatching("fabric.mod.json") {
      expand(mapOf("version" to modVersion))
    }
  }
}

project(":bridge-fabric") {
  apply(plugin = "java")

  group = property("maven_group").toString()

  extensions.configure<JavaPluginExtension> {
    toolchain.languageVersion.set(JavaLanguageVersion.of(21))
  }

  repositories {
    mavenCentral()
  }

  dependencies {
    add("implementation", "com.google.code.gson:gson:2.13.1")
    add("testImplementation", platform("org.junit:junit-bom:5.12.2"))
    add("testImplementation", "org.junit.jupiter:junit-jupiter")
    add("testRuntimeOnly", "org.junit.platform:junit-platform-launcher")
  }

  tasks.withType<Test>().configureEach {
    useJUnitPlatform()
  }
}
