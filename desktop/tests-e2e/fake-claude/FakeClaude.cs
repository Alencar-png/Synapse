// Um "claude" de mentira para os testes de ponta a ponta.
//
// O app chama `claude -p --output-format stream-json` com a mensagem no stdin
// e lê um JSON por linha no stdout. Este programa responde com o mesmo
// protocolo, de forma determinística, sem rede e sem custo:
//
//   - mensagem com "FALHE"      → sai com código 1 e um motivo no stderr;
//   - mensagem com "FERRAMENTA" → anuncia um tool_use (Read) antes do texto;
//   - qualquer outra            → um bloco de texto e um `result` de sucesso.
//
// Compilado pelo global-setup com o csc do .NET Framework, presente em todo
// Windows. Node recusa spawn de .bat/.cmd sem shell, então precisa ser um .exe.

using System;
using System.IO;
using System.Text;

static class FakeClaude
{
    static string Esc(string s)
    {
        return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "").Replace("\n", "\\n");
    }

    static int Main(string[] args)
    {
        var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        string msg = stdin.ReadToEnd().Trim();

        string session = "";
        for (int i = 0; i < args.Length - 1; i++)
        {
            if (args[i] == "--session-id" || args[i] == "--resume") session = args[i + 1];
        }

        if (msg.Contains("FALHE"))
        {
            Console.Error.WriteLine("erro simulado do Claude");
            return 1;
        }

        var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        stdout.AutoFlush = true;

        if (msg.Contains("FERRAMENTA"))
        {
            stdout.WriteLine("{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"name\":\"Read\",\"input\":{\"file_path\":\"C:\\\\projeto\\\\README.md\"}}]}}");
        }

        string texto = "Resposta de teste: " + Esc(msg);
        stdout.WriteLine("{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"" + texto + "\"}]}}");
        stdout.WriteLine("{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"" + texto + "\",\"session_id\":\"" + Esc(session) + "\"}");
        return 0;
    }
}
