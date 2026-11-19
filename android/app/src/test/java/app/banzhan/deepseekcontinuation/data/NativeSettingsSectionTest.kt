package app.banzhan.deepseekcontinuation.data

import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

class NativeSettingsSectionTest {
    @Test fun routesKnownSectionsAndPreservesOldSettingsIndex() {
        assertNull(NativeSettingsSection.fromPayload(null))
        val expected = mapOf("service" to "#settings", "data" to "#settings/data",
            "about" to "#settings/about", "developer" to "#settings/about")
        expected.forEach { (name, destination) ->
            val section = NativeSettingsSection.fromPayload(Json.parseToJsonElement("""{"section":"$name"}"""))
            assertEquals(name, section?.route)
            assertEquals(destination, section?.returnFragment)
        }
    }

    @Test fun rejectsUnknownActionsAndInvalidPayloads() {
        listOf("{}", "null", "[]", """{"section":null}""", """{"section":"delete"}""",
            """{"section":"https://example.com"}""").forEach { raw ->
            assertThrows(Exception::class.java) { NativeSettingsSection.fromPayload(Json.parseToJsonElement(raw)) }
        }
    }
}
