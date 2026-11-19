package app.banzhan.deepseekcontinuation.data

import kotlinx.serialization.decodeFromString
import org.junit.Assert.*
import org.junit.Test

class OrganizationProviderTest {
    @Test fun legacySettingsAreDecodedButNeverSelectedForANewTask() {
        val legacy = appJson.decodeFromString<ServiceSettings>(
            """{"followChat":false,"mode":"companion","baseUrl":"https://legacy.example","companionUrl":"https://companion.example","apiKey":"legacy-key","trialToken":"legacy-token"}""")
        assertEquals("legacy-key", legacy.apiKey)
        assertEquals("https://companion.example", legacy.companionUrl)
        val user = AccountUser("user-id", "user", "open", "", managedEligible = true)
        val state = AppState(settings = legacy, account = AccountState(user))
        assertEquals(ServiceSettings(), state.organizationSettings)
        assertThrows(IllegalArgumentException::class.java) {
            validateOrganizationConfiguration(state.organizationSettings)
        }
    }

    @Test fun personalChatControlsNewTasksWithoutChangingFrozenTaskCredentials() {
        val configured = ServiceSettings(apiKey = "native-key", baseUrl = "https://native.example/v1",
            model = "native-model", contextTokens = 64000)
        val provider = NativeChatProvider("personal", "https://chat.example/v1", "chat-model", "chat-key")
        val state = AppState(settings = configured, chatProvider = provider)
        val task = validateOrganizationConfiguration(state.organizationSettings)
        assertEquals(listOf(provider.baseUrl, provider.model, provider.apiKey), listOf(task.baseUrl, task.model, task.apiKey))
        assertEquals(ServiceSettings().contextTokens, task.contextTokens)
        assertEquals("https://chat.example/v1/chat/completions", SummaryNetwork.chatEndpoint(state.copy(chatProvider = provider.copy(baseUrl = "https://chat.example")).organizationSettings.baseUrl).toString())
        assertEquals("https://chat.example/custom/chat/completions", SummaryNetwork.chatEndpoint(state.copy(chatProvider = provider.copy(baseUrl = "https://chat.example/custom")).organizationSettings.baseUrl).toString())
        val cleared = state.copy(chatProvider = provider.copy(apiKey = "")).organizationSettings
        assertEquals("", cleared.apiKey)
        assertThrows(IllegalArgumentException::class.java) { validateOrganizationConfiguration(cleared) }
        assertEquals("next-model", state.copy(chatProvider = provider.copy(model = "next-model")).organizationSettings.model)
        assertEquals("chat-model", task.model)
        assertEquals("chat-key", task.apiKey)
    }

    @Test fun managedChatRequiresCurrentEligibility() {
        val provider = NativeChatProvider("managed", "https://api.deepseek.com", "deepseek-flash", "")
        val state = AppState(settings = ServiceSettings(companionUrl = "https://prior.example", trialToken = "legacy-token"),
            chatProvider = provider)
        assertEquals("byok", state.organizationSettings.mode)
        assertTrue(state.organizationSettings.apiKey.isEmpty())
        val user = AccountUser("user-id", "user", "open", "", managedEligible = true)
        val managed = state.copy(account = AccountState(user)).organizationSettings
        assertEquals("companion", managed.mode)
        assertEquals(CHAT_API, managed.companionUrl)
        assertTrue(managed.trialToken.isEmpty())
    }
}
