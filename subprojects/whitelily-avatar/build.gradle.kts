import net.fabricmc.loom.api.LoomGradleExtensionAPI
import org.gradle.api.plugins.BasePluginExtension
import org.gradle.api.plugins.JavaPluginExtension
import org.gradle.api.tasks.Exec
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.bundling.Jar
import org.gradle.api.tasks.testing.Test
import org.gradle.jvm.toolchain.JavaLanguageVersion
import org.gradle.language.jvm.tasks.ProcessResources
import java.io.File
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.nio.charset.StandardCharsets.UTF_8
import java.nio.file.Files
import java.nio.file.LinkOption
import java.security.MessageDigest
import java.util.Base64
import java.util.HexFormat
import java.util.zip.ZipInputStream

plugins {
  id("fabric-loom") version "1.10.5" apply false
}

val fabricApiDistribution = configurations.create("fabricApiDistribution") {
  isCanBeConsumed = false
  isCanBeResolved = true
  isTransitive = false
}
repositories {
  maven("https://maven.fabricmc.net/")
}

dependencies {
  add(fabricApiDistribution.name, "net.fabricmc.fabric-api:fabric-api:${property("fabric_api_version")}")
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
    add(
      "modImplementation",
      project(mapOf("path" to ":bridge-fabric", "configuration" to "namedElements")),
    )
    add("modImplementation", "net.fabricmc.fabric-api:fabric-api:${property("fabric_api_version")}")
    add("modCompileOnly", "software.bernie.geckolib:geckolib-fabric-1.21.5:${property("geckolib_version")}")
    add("implementation", "com.google.code.gson:gson:2.13.1")
    add("testImplementation", platform("org.junit:junit-bom:5.12.2"))
    add("testImplementation", "org.junit.jupiter:junit-jupiter")
    add("testRuntimeOnly", "org.junit.platform:junit-platform-launcher")
  }

  configurations.named("testRuntimeClasspath") {
    extendsFrom(configurations.named("modCompileOnly").get())
  }

  tasks.withType<Test>().configureEach {
    useJUnitPlatform()
  }

  tasks.named<ProcessResources>("processResources") {
    inputs.property("version", modVersion)
    exclude("assets/whitelily_avatar/shaders/**")
    exclude("assets/whitelily_avatar/geckolib/**")
    exclude("assets/whitelily_avatar/textures/entity/**")
    filesMatching("fabric.mod.json") {
      expand(mapOf("version" to modVersion))
    }
  }

  tasks.named<Jar>("jar") {
    from(rootProject.file("../../LICENSE")) {
      rename { "LICENSE" }
    }
  }
}

project(":bridge-fabric") {
  apply(plugin = "fabric-loom")
  apply(plugin = "java")

  val bridgeVersion = property("bridge_version").toString()
  val minecraftVersion = property("minecraft_version").toString()
  version = bridgeVersion
  group = property("maven_group").toString()

  val loom = extensions.getByType<LoomGradleExtensionAPI>()
  loom.mixin.defaultRefmapName.set("whitelily-bridge-fabric-refmap.json")
  extensions.configure<BasePluginExtension> {
    archivesName.set("whitelily-bridge-fabric-$minecraftVersion")
  }
  extensions.configure<JavaPluginExtension> {
    toolchain.languageVersion.set(JavaLanguageVersion.of(21))
  }

  repositories {
    mavenCentral()
    maven("https://maven.fabricmc.net/")
  }

  dependencies {
    add("mappings", loom.officialMojangMappings())
    add("minecraft", "com.mojang:minecraft:$minecraftVersion")
    add("modImplementation", "net.fabricmc:fabric-loader:${property("fabric_loader_version")}")
    add("implementation", "com.google.code.gson:gson:2.13.1")
    add("testImplementation", platform("org.junit:junit-bom:5.12.2"))
    add("testImplementation", "org.junit.jupiter:junit-jupiter")
    add("testRuntimeOnly", "org.junit.platform:junit-platform-launcher")
  }

  tasks.withType<Test>().configureEach {
    useJUnitPlatform()
    dependsOn(tasks.named("remapJar"))
    environment(
      "LOCALAPPDATA",
      layout.buildDirectory.dir("test-local-app-data").get().asFile.absolutePath,
    )
    systemProperty(
      "whitelily.bridge.jar",
      layout.buildDirectory.file("libs/whitelily-bridge-fabric-$minecraftVersion-$bridgeVersion.jar").get().asFile.absolutePath,
    )
    systemProperty("whitelily.license", rootProject.file("../../LICENSE").absolutePath)
  }

  tasks.named<ProcessResources>("processResources") {
    inputs.property("version", bridgeVersion)
    filesMatching("fabric.mod.json") {
      expand(mapOf("version" to bridgeVersion))
    }
  }

  tasks.named<Jar>("jar") {
    from(rootProject.file("../../LICENSE")) {
      rename { "LICENSE" }
    }
  }
}

allprojects {
  tasks.withType<Jar>().configureEach {
    isPreserveFileTimestamps = false
    isReproducibleFileOrder = true
  }
}

data class StagedArtifact(
  val component: String,
  val fileName: String,
  val source: File,
  val modId: String,
  val version: String,
  val expectedBytes: Long? = null,
  val expectedSha256: String? = null,
)

data class StagedLicense(val fileName: String, val bytes: ByteArray, val source: File? = null)

data class PreparedArtifact(val artifact: StagedArtifact, val bytes: ByteArray, val sha256: String)

fun sha256(bytes: ByteArray): String =
  HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes))

fun exactZipEntry(jarBytes: ByteArray, entryName: String): ByteArray {
  val maximumLicenseBytes = 1024 * 1024
  var matched: ByteArray? = null
  ZipInputStream(ByteArrayInputStream(jarBytes)).use { zip ->
    var entry = zip.nextEntry
    while (entry != null) {
      if (entry.name == entryName) {
        check(matched == null && !entry.isDirectory) {
          "Reviewed component license input is invalid"
        }
        val bytes = ByteArrayOutputStream()
        val buffer = ByteArray(8192)
        var read = zip.read(buffer)
        while (read >= 0) {
          check(bytes.size() + read <= maximumLicenseBytes) {
            "Reviewed component license input is invalid"
          }
          bytes.write(buffer, 0, read)
          read = zip.read(buffer)
        }
        matched = bytes.toByteArray().also {
          check(it.isNotEmpty()) { "Reviewed component license input is invalid" }
        }
      }
      zip.closeEntry()
      entry = zip.nextEntry
    }
  }
  return checkNotNull(matched) { "Reviewed component license input is missing" }
}

fun jsonString(value: String): String =
  buildString {
    append('"')
    for (character in value) {
      when (character) {
        '"' -> append("\\\"")
        '\\' -> append("\\\\")
        '\b' -> append("\\b")
        '\u000c' -> append("\\f")
        '\n' -> append("\\n")
        '\r' -> append("\\r")
        '\t' -> append("\\t")
        else -> if (character.code < 0x20) append("\\u%04x".format(character.code)) else append(character)
      }
    }
    append('"')
  }

val minecraftVersion = property("minecraft_version").toString()
val componentVersion = property("mod_version").toString()
val bridgeVersion = property("bridge_version").toString()
val fabricApiVersion = property("fabric_api_version").toString()
val bridgeOutputName = "whitelily-bridge-fabric-$minecraftVersion-$bridgeVersion.jar"
val avatarOutputName = "whitelily-avatar-fabric-$minecraftVersion-$componentVersion.jar"
val fabricApiOutputName = "fabric-api-$fabricApiVersion.jar"
val manifestName = "minecraft-components-manifest.json"
val licenseOutputNames =
  listOf(
    "WhiteLily-LICENSE.txt",
    "WhiteLily-NOTICE.txt",
    "Fabric-API-LICENSE.txt",
  )
val stagedOutputNames =
  listOf(
    bridgeOutputName,
    avatarOutputName,
    fabricApiOutputName,
    *licenseOutputNames.toTypedArray(),
    manifestName,
  )
val bridgeJar =
  project(":bridge-fabric").file("build/libs/whitelily-bridge-fabric-$minecraftVersion-$bridgeVersion.jar")
val avatarJar = project(":mod-fabric").file("build/libs/whitelily-avatar-fabric-$componentVersion.jar")
val stagingDirectory = file("../../build/minecraft-components")
val stagingDirectoryExistedAtConfiguration = stagingDirectory.exists()
val stagingTransactionScript = file("tools/stage-minecraft-components.mjs")
val stagingTransactionTest = file("tools/stage-minecraft-components.test.mjs")

val testComponentPackStagingTransaction =
  tasks.register<Exec>("testComponentPackStagingTransaction") {
    group = "verification"
    description = "Exercises deterministic no-clobber component staging and rollback boundaries."
    workingDir(rootProject.projectDir)
    commandLine("node", "--test", stagingTransactionTest.absolutePath)
    inputs.files(stagingTransactionScript, stagingTransactionTest)
      .withPathSensitivity(PathSensitivity.RELATIVE)
  }

val stageMinecraftComponents = tasks.register("stageMinecraftComponents") {
  group = "distribution"
  description = "Stages the reviewed Minecraft component pack with a deterministic manifest."
  dependsOn(testComponentPackStagingTransaction, ":bridge-fabric:remapJar", ":mod-fabric:remapJar")
  inputs.property("minecraftVersion", minecraftVersion)
  inputs.property("componentVersion", componentVersion)
  inputs.property("fabricApiCoordinate", "net.fabricmc.fabric-api:fabric-api:$fabricApiVersion")
  inputs.property("fabricApiExpectedBytes", project.property("fabric_api_distribution_bytes"))
  inputs.property("fabricApiExpectedSha256", project.property("fabric_api_distribution_sha256"))
  for (
    pin in
      listOf(
        "bridge_distribution_bytes",
        "bridge_distribution_sha256",
        "avatar_distribution_bytes",
        "avatar_distribution_sha256",
        "whitelily_license_bytes",
        "whitelily_license_sha256",
        "whitelily_notice_bytes",
        "whitelily_notice_sha256",
        "fabric_api_license_bytes",
        "fabric_api_license_sha256",
        "component_manifest_bytes",
        "component_manifest_sha256",
      )
  ) {
    inputs.property(pin, project.property(pin))
  }
  inputs.property("artifactOutputNames", stagedOutputNames)
  inputs.property(
    "artifactAuthorities",
    listOf("bridge:whitelily_bridge", "avatar:whitelily_avatar", "avatar:fabric-api"),
  )
  inputs.property("fabricApiLicenseEntry", "LICENSE-fabric-api")
  inputs.files(fabricApiDistribution)
    .withPathSensitivity(PathSensitivity.NAME_ONLY)
  inputs.files(bridgeJar, avatarJar).withPathSensitivity(PathSensitivity.RELATIVE)
  inputs.files(file("../../LICENSE"), file("../../NOTICE"), stagingTransactionScript)
    .withPathSensitivity(PathSensitivity.RELATIVE)
  outputs.dir(stagingDirectory)
  outputs.upToDateWhen {
    stagingDirectory.parentFile.listFiles()?.none { candidate ->
      candidate.name.startsWith(".${stagingDirectory.name}.cleanup-")
    } ?: true
  }

  doLast {
    val artifacts =
      listOf(
        StagedArtifact(
          "bridge",
          bridgeOutputName,
          bridgeJar,
          "whitelily_bridge",
          bridgeVersion,
          project.property("bridge_distribution_bytes").toString().toLong(),
          project.property("bridge_distribution_sha256").toString(),
        ),
        StagedArtifact(
          "avatar",
          avatarOutputName,
          avatarJar,
          "whitelily_avatar",
          componentVersion,
          project.property("avatar_distribution_bytes").toString().toLong(),
          project.property("avatar_distribution_sha256").toString(),
        ),
        StagedArtifact(
          "avatar",
          fabricApiOutputName,
          fabricApiDistribution.singleFile,
          "fabric-api",
          fabricApiVersion,
          project.property("fabric_api_distribution_bytes").toString().toLong(),
          project.property("fabric_api_distribution_sha256").toString(),
        ),
      )
    val preparedArtifacts =
      artifacts.map { artifact ->
        check(
          Files.isRegularFile(artifact.source.toPath(), LinkOption.NOFOLLOW_LINKS) &&
            artifact.source.name.endsWith(".jar"),
        ) {
          "Reviewed component artifact is missing"
        }
        val sourceBytes = artifact.source.readBytes()
        val sourceHash = sha256(sourceBytes)
        artifact.expectedBytes?.let {
          check(sourceBytes.size.toLong() == it) { "Reviewed component byte count changed" }
        }
        artifact.expectedSha256?.let {
          check(sourceHash == it) { "Reviewed component hash changed" }
        }
        PreparedArtifact(artifact, sourceBytes, sourceHash)
      }
    val projectLicense = file("../../LICENSE")
    val projectNotice = file("../../NOTICE")
    check(
      Files.isRegularFile(projectLicense.toPath(), LinkOption.NOFOLLOW_LINKS) &&
        Files.isRegularFile(projectNotice.toPath(), LinkOption.NOFOLLOW_LINKS),
    ) { "Reviewed component license input is invalid" }
    val licenses =
      listOf(
        StagedLicense("WhiteLily-LICENSE.txt", projectLicense.readBytes(), projectLicense),
        StagedLicense("WhiteLily-NOTICE.txt", projectNotice.readBytes(), projectNotice),
        StagedLicense(
          "Fabric-API-LICENSE.txt",
          exactZipEntry(preparedArtifacts[2].bytes, "LICENSE-fabric-api"),
        ),
      )
    val reviewedLicensePins =
      mapOf(
        "WhiteLily-LICENSE.txt" to
          Pair("whitelily_license_bytes", "whitelily_license_sha256"),
        "WhiteLily-NOTICE.txt" to
          Pair("whitelily_notice_bytes", "whitelily_notice_sha256"),
        "Fabric-API-LICENSE.txt" to
          Pair("fabric_api_license_bytes", "fabric_api_license_sha256"),
      )
    for (license in licenses) {
      val pins = checkNotNull(reviewedLicensePins[license.fileName])
      check(license.bytes.size.toLong() == project.property(pins.first).toString().toLong()) {
        "Reviewed component license byte count changed"
      }
      check(sha256(license.bytes) == project.property(pins.second).toString()) {
        "Reviewed component license hash changed"
      }
    }
    val artifactManifest =
      preparedArtifacts.map { prepared ->
        val artifact = prepared.artifact
        val prior =
          if (artifact.component == "bridge") {
            "[{\"fileName\": \"whitelily-bridge-fabric-1.21.5-0.1.1.jar\", \"bytes\": 52087, " +
              "\"sha256\": \"8a6e00d47a28799798ffa5d561156ea7ceb0f697a0beb2cc7c55b34f6f81b514\", " +
              "\"modId\": \"whitelily_bridge\", \"version\": \"0.1.1\"}," +
              "{\"fileName\": \"whitelily-bridge-fabric-1.21.5-0.1.0.jar\", \"bytes\": 51837, " +
              "\"sha256\": \"380721d28236f5ad8206fd8d69af1e5629d741e9d38ec27c26c052c95266b6ce\", " +
              "\"modId\": \"whitelily_bridge\", \"version\": \"0.1.0\"}]"
          } else {
            "[]"
          }
        "    {\"component\": \"${artifact.component}\", \"fileName\": \"${artifact.fileName}\", " +
          "\"bytes\": ${prepared.bytes.size}, \"sha256\": \"${prepared.sha256}\", " +
          "\"modId\": \"${artifact.modId}\", \"version\": \"${artifact.version}\", \"prior\": $prior}"
      }
    val licenseManifest =
      licenses.map { license ->
        "    {\"fileName\": \"${license.fileName}\", \"bytes\": ${license.bytes.size}, " +
          "\"sha256\": \"${sha256(license.bytes)}\"}"
      }
    val manifest =
      "{\n" +
        "  \"schemaVersion\": 1,\n" +
        "  \"minecraftVersion\": \"$minecraftVersion\",\n" +
        "  \"artifacts\": [\n" +
        artifactManifest.joinToString(",\n") +
        "\n  ],\n" +
        "  \"licenses\": [\n" +
        licenseManifest.joinToString(",\n") +
        "\n  ]\n" +
        "}\n"
    val manifestBytes = manifest.toByteArray(UTF_8)
    check(
      manifestBytes.size.toLong() ==
        project.property("component_manifest_bytes").toString().toLong(),
    ) { "Reviewed component manifest byte count changed: ${manifestBytes.size}" }
    check(sha256(manifestBytes) == project.property("component_manifest_sha256").toString()) {
      "Reviewed component manifest hash changed: ${sha256(manifestBytes)}"
    }
    val fileRequests =
      preparedArtifacts.map { prepared ->
        "{\"name\":" + jsonString(prepared.artifact.fileName) +
          ",\"source\":" + jsonString(prepared.artifact.source.absolutePath) +
          ",\"bytes\":" + prepared.bytes.size +
          ",\"sha256\":" + jsonString(prepared.sha256) + "}"
      } +
        licenses.map { license ->
          val sourceAuthority =
            license.source?.let { ",\"source\":" + jsonString(it.absolutePath) }
              ?: ",\"contentBase64\":" + jsonString(Base64.getEncoder().encodeToString(license.bytes))
          "{\"name\":" + jsonString(license.fileName) + sourceAuthority +
            ",\"bytes\":" + license.bytes.size +
            ",\"sha256\":" + jsonString(sha256(license.bytes)) + "}"
        } +
        listOf(
          manifestBytes.let { bytes ->
            "{\"name\":" + jsonString(manifestName) +
              ",\"contentBase64\":" + jsonString(Base64.getEncoder().encodeToString(bytes)) +
              ",\"bytes\":" + bytes.size +
              ",\"sha256\":" + jsonString(sha256(bytes)) + "}"
          },
        )
    val currentFileRequests =
      preparedArtifacts.map { prepared ->
        "{\"name\":" + jsonString(prepared.artifact.fileName) +
          ",\"bytes\":" + prepared.bytes.size +
          ",\"sha256\":" + jsonString(prepared.sha256) + "}"
      } +
        licenses.map { license ->
          "{\"name\":" + jsonString(license.fileName) +
            ",\"bytes\":" + license.bytes.size +
            ",\"sha256\":" + jsonString(sha256(license.bytes)) + "}"
        } +
        listOf(
          "{\"name\":" + jsonString(manifestName) +
            ",\"bytes\":" + manifestBytes.size +
            ",\"sha256\":" + jsonString(sha256(manifestBytes)) + "}",
        )
    val legacyFileRequests =
      listOf(
        Triple("fabric-api-0.128.2+1.21.5.jar", 2_248_994, "a82fd00827206e911936ed1e0ceaec6eb55d061ca5d3c5d63c7f0031426d29ae"),
        Triple("Fabric-API-LICENSE.txt", 11_357, "b40930bbcf80744c86c46a12bc9da056641d722716c378f5659b9e555ef833e1"),
        Triple("geckolib-fabric-1.21.5-5.1.0.jar", 670_425, "885ef4b03cd438c7d2ec9f59bb492f3af6ba2b73aa0493afc4f80801b5a9126c"),
        Triple("GeckoLib-LICENSE.txt", 1_065, "5f2943625776c6126cd252652f4c57d2fb187d339a20fa065a2b7c619165a52f"),
        Triple("minecraft-components-manifest.json", 1_984, "9f6d60d8e8f23543689d5e61e9aa6656271daf8cf4b8028bdfebb305a12eaab0"),
        Triple("whitelily-avatar-fabric-1.21.5-0.1.0.jar", 55_627, "fff00f66e4beab2eff1e51f253608b198f43aa0a12443fbe07f7f3fd48278872"),
        Triple("whitelily-bridge-fabric-1.21.5-0.1.2.jar", 53_984, "ac5bfab545b723b2346aeb017b3a6ea3186a6cbced370e16097f3836b128746d"),
        Triple("WhiteLily-LICENSE.txt", 11_123, "226d0e41f61309952c27fcc11a5140c4e735115f702ff0484ff0c25cfbbeee16"),
        Triple("WhiteLily-NOTICE.txt", 697, "6323cb4b742d322d61ee47279d71d0f0de496568cf1f2f793fea104a58ab0dde"),
      ).map { (name, bytes, hash) ->
        "{\"name\":" + jsonString(name) + ",\"bytes\":" + bytes +
          ",\"sha256\":" + jsonString(hash) + "}"
      }
    val previousNativeSkinFileRequests =
      listOf(
        Triple("fabric-api-0.128.2+1.21.5.jar", 2_248_994, "a82fd00827206e911936ed1e0ceaec6eb55d061ca5d3c5d63c7f0031426d29ae"),
        Triple("Fabric-API-LICENSE.txt", 11_357, "b40930bbcf80744c86c46a12bc9da056641d722716c378f5659b9e555ef833e1"),
        Triple("minecraft-components-manifest.json", 1_624, "efe26a3217f02e1a5295c7462f5effc97612ae605e3c4bdb584e52d93563cda0"),
        Triple("whitelily-avatar-fabric-1.21.5-0.1.0.jar", 256_057, "4225e0901bcc5de08dfd435d23f01838215f932a9495a14299334fe5049d132e"),
        Triple("whitelily-bridge-fabric-1.21.5-0.1.2.jar", 53_984, "ac5bfab545b723b2346aeb017b3a6ea3186a6cbced370e16097f3836b128746d"),
        Triple("WhiteLily-LICENSE.txt", 11_123, "226d0e41f61309952c27fcc11a5140c4e735115f702ff0484ff0c25cfbbeee16"),
        Triple("WhiteLily-NOTICE.txt", 795, "bc5ab24ff5624664bc3ef3d5b850ac3c820dddf3b2f15a4125b355f1c65a2c2a"),
      ).map { (name, bytes, hash) ->
        "{\"name\":" + jsonString(name) + ",\"bytes\":" + bytes +
          ",\"sha256\":" + jsonString(hash) + "}"
      }
    val existingNames = stagingDirectory.listFiles()?.map { it.name }?.toSet().orEmpty()
    val existingManifest = stagingDirectory.resolve(manifestName).toPath()
    val existingManifestIsCurrent =
      Files.isRegularFile(existingManifest, LinkOption.NOFOLLOW_LINKS) &&
        Files.size(existingManifest) == manifestBytes.size.toLong() &&
        sha256(Files.readAllBytes(existingManifest)) == sha256(manifestBytes)
    val previousFileRequests =
      when {
        existingNames.contains("geckolib-fabric-1.21.5-5.1.0.jar") -> legacyFileRequests
        existingManifestIsCurrent -> currentFileRequests
        else -> previousNativeSkinFileRequests
      }
    val request =
      "{\"destination\":" + jsonString(stagingDirectory.absolutePath) +
        ",\"allowPreparedEmptyDestination\":" + !stagingDirectoryExistedAtConfiguration +
        ",\"specification\":{\"files\":[" + fileRequests.joinToString(",") +
        "],\"previousFiles\":[" + previousFileRequests.joinToString(",") + "]}}"
    val process = ProcessBuilder("node", stagingTransactionScript.absolutePath)
      .directory(rootProject.projectDir)
      .start()
    process.outputStream.bufferedWriter(UTF_8).use { writer -> writer.write(request) }
    val exitCode = process.waitFor()
    check(exitCode == 0) { "Component staging transaction failed" }
  }
}

project(":mod-fabric") {
  tasks.withType<Test>().configureEach {
    dependsOn(stageMinecraftComponents, testComponentPackStagingTransaction)
    inputs.dir(stagingDirectory)
      .withPropertyName("reviewedMinecraftComponentPack")
      .withPathSensitivity(PathSensitivity.RELATIVE)
  }
}
