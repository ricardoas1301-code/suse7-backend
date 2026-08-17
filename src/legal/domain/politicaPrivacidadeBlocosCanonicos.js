// Conteúdo canônico — Política de Privacidade V2 (13/08/2026) — SSOT backend (LEGAL.DOCUMENT.SSOT.01)
// Canal oficial de privacidade/LGPD: contato@suse7.com.br

import { CANAL_CONTATO_OFICIAL_SUSE7 } from "./contatoInstitucionalSuse7.js";

void CANAL_CONTATO_OFICIAL_SUSE7;

/** @type {import("./privacidadeDocumento").PrivacidadeBloco[]} */
export const POLITICA_PRIVACIDADE_BLOCOS_CANONICOS = [
  {
    type: "paragraph",
    parts: [
      {
        text: "A proteção das informações de nossos Usuários faz parte da forma como o SUSE7 desenvolve e opera seus serviços.",
      },
    ],
  },
  {
    type: "paragraph",
    parts: [
      {
        text: 'Esta Política de Privacidade ("Política") explica quais informações podem ser tratadas durante o uso da Plataforma, por que elas são utilizadas, com quem poderão ser compartilhadas, por quanto tempo poderão ser mantidas e quais direitos os titulares possuem.',
      },
    ],
  },
  {
    type: "paragraph",
    parts: [
      { text: "Esta Política deve ser lida em conjunto com os " },
      { text: "Termos e Condições de Uso do SUSE7", to: "/termos" },
      { text: "." },
    ],
  },
  { type: "heading", text: "1. Quem somos" },
  {
    type: "paragraph",
    parts: [
      { text: "A Plataforma SUSE7 é disponibilizada por " },
      { text: "[RAZÃO SOCIAL RESPONSÁVEL PELO SUSE7]", bold: true },
      { text: ", inscrita no CNPJ sob nº " },
      { text: "[CNPJ]", bold: true },
      { text: ", com sede em " },
      { text: "[ENDEREÇO]", bold: true },
      { text: "." },
    ],
  },
  {
    type: "paragraph",
    parts: [
      {
        text: "Dependendo do contexto do tratamento, o SUSE7 poderá atuar como Controladora ou Operadora de dados pessoais.",
      },
    ],
  },
  {
    type: "paragraph",
    parts: [
      {
        text: "Quando determinamos as finalidades e os meios de determinado tratamento, atuamos como Controladora.",
      },
    ],
  },
  {
    type: "paragraph",
    parts: [
      {
        text: "Quando processamos informações em nome do Seller e de acordo com suas instruções, como poderá ocorrer com determinados dados obtidos de suas integrações, poderemos atuar como Operadora.",
      },
    ],
  },
  { type: "heading", text: "2. A quem esta Política se aplica" },
  {
    type: "paragraph",
    parts: [{ text: "Esta Política se aplica a pessoas que:" }],
  },
  {
    type: "list",
    items: [
      [{ text: "acessam os sites e páginas públicas do SUSE7;" }],
      [{ text: "criam ou utilizam uma Conta;" }],
      [{ text: "representam uma empresa cadastrada;" }],
      [{ text: "são cadastradas como usuários autorizados;" }],
      [{ text: "entram em contato com nosso atendimento;" }],
      [{ text: "interagem com comunicações do SUSE7;" }],
      [{ text: "utilizam integrações disponibilizadas pela Plataforma." }],
    ],
  },
  {
    type: "paragraph",
    parts: [
      {
        text: "Determinados dados relacionados aos consumidores dos Sellers poderão ser processados quando forem necessários para fornecer funcionalidades vinculadas a pedidos, vendas e operações integradas aos marketplaces.",
      },
    ],
  },
  { type: "heading", text: "3. Dados que podemos tratar" },
  {
    type: "paragraph",
    parts: [
      {
        text: "As informações efetivamente tratadas dependerão das funcionalidades utilizadas.",
      },
    ],
  },
  { type: "subheading", text: "3.1. Dados de cadastro e identificação" },
  {
    type: "paragraph",
    parts: [{ text: "Podem incluir:" }],
  },
  {
    type: "list",
    items: [
      [{ text: "nome;" }],
      [{ text: "nome empresarial;" }],
      [{ text: "nome fantasia;" }],
      [{ text: "CPF ou CNPJ, quando necessário;" }],
      [{ text: "e-mail;" }],
      [{ text: "telefone e WhatsApp;" }],
      [{ text: "endereço;" }],
      [{ text: "cargo ou função;" }],
      [{ text: "informações relacionadas à empresa representada." }],
    ],
  },
  { type: "subheading", text: "3.2. Dados de autenticação e segurança" },
  {
    type: "paragraph",
    parts: [{ text: "Podem incluir:" }],
  },
  {
    type: "list",
    items: [
      [{ text: "identificadores de usuário;" }],
      [{ text: "informações necessárias à autenticação;" }],
      [{ text: "registros de sessões;" }],
      [{ text: "data e horário de acessos;" }],
      [{ text: "endereço IP;" }],
      [{ text: "dispositivo e navegador;" }],
      [{ text: "registros relacionados à segurança da Conta." }],
    ],
  },
  {
    type: "paragraph",
    parts: [
      {
        text: "Senhas devem ser tratadas utilizando mecanismos apropriados de proteção e não devem ser armazenadas em texto aberto.",
      },
    ],
  },
  { type: "subheading", text: "3.3. Dados de integrações" },
  {
    type: "paragraph",
    parts: [
      {
        text: "Quando o Usuário conecta uma conta de marketplace ou outro serviço, poderemos tratar:",
      },
    ],
  },
  {
    type: "list",
    items: [
      [{ text: "identificadores da conta integrada;" }],
      [{ text: "permissões concedidas;" }],
      [{ text: "tokens de acesso e renovação;" }],
      [{ text: "status da conexão;" }],
      [{ text: "eventos de sincronização;" }],
      [{ text: "informações necessárias para manter a integração autorizada." }],
    ],
  },
  {
    type: "paragraph",
    parts: [
      {
        text: "Essas credenciais técnicas são utilizadas somente para as finalidades relacionadas à integração e operação dos serviços autorizados.",
      },
    ],
  },
  { type: "subheading", text: "3.4. Dados da operação comercial" },
  {
    type: "paragraph",
    parts: [
      {
        text: "Dependendo do marketplace e das permissões concedidas, poderão ser processadas informações como:",
      },
    ],
  },
  {
    type: "list",
    items: [
      [{ text: "produtos;" }],
      [{ text: "SKUs;" }],
      [{ text: "anúncios;" }],
      [{ text: "preços;" }],
      [{ text: "custos;" }],
      [{ text: "tributos;" }],
      [{ text: "taxas e comissões;" }],
      [{ text: "fretes;" }],
      [{ text: "promoções;" }],
      [{ text: "pedidos;" }],
      [{ text: "vendas;" }],
      [{ text: "cancelamentos;" }],
      [{ text: "devoluções;" }],
      [{ text: "dados de desempenho;" }],
      [{ text: "indicadores de saúde da conta;" }],
      [{ text: "indicadores de qualidade de anúncios;" }],
      [{ text: "métricas financeiras e comerciais." }],
    ],
  },
  {
    type: "paragraph",
    parts: [
      {
        text: "Quando os dados disponibilizados pelo marketplace incluírem informações relacionadas a compradores ou terceiros, o tratamento será limitado ao necessário para fornecer as funcionalidades contratadas.",
      },
    ],
  },
  { type: "subheading", text: "3.5. Dados financeiros e de assinatura" },
  {
    type: "paragraph",
    parts: [{ text: "Podem incluir:" }],
  },
  {
    type: "list",
    items: [
      [{ text: "Plano contratado;" }],
      [{ text: "histórico de cobrança;" }],
      [{ text: "valores;" }],
      [{ text: "vencimentos;" }],
      [{ text: "status de pagamento;" }],
      [{ text: "documentos fiscais;" }],
      [{ text: "identificadores de transações." }],
    ],
  },
  {
    type: "paragraph",
    parts: [
      {
        text: "Quando pagamentos forem processados por provedores especializados, determinadas informações financeiras poderão ser tratadas diretamente por esses prestadores.",
      },
    ],
  },
  { type: "subheading", text: "3.6. Dados de suporte e comunicação" },
  {
    type: "paragraph",
    parts: [
      {
        text: "Quando o Usuário entra em contato conosco, poderemos registrar:",
      },
    ],
  },
  {
    type: "list",
    items: [
      [{ text: "identificação;" }],
      [{ text: "canal utilizado;" }],
      [{ text: "conteúdo da solicitação;" }],
      [{ text: "informações técnicas relacionadas ao problema;" }],
      [{ text: "histórico de atendimento;" }],
      [{ text: "arquivos ou evidências enviados voluntariamente." }],
    ],
  },
  { type: "subheading", text: "3.7. Dados técnicos e de navegação" },
  {
    type: "paragraph",
    parts: [
      {
        text: "Podem ser coletadas informações técnicas necessárias ao funcionamento, proteção e melhoria da Plataforma, incluindo:",
      },
    ],
  },
  {
    type: "list",
    items: [
      [{ text: "endereço IP;" }],
      [{ text: "navegador;" }],
      [{ text: "sistema operacional;" }],
      [{ text: "dispositivo;" }],
      [{ text: "páginas acessadas;" }],
      [{ text: "horários de acesso;" }],
      [{ text: "eventos técnicos;" }],
      [{ text: "falhas;" }],
      [{ text: "métricas de desempenho;" }],
      [{ text: "registros de auditoria e segurança." }],
    ],
  },
  { type: "heading", text: "4. Para que utilizamos os dados" },
  {
    type: "paragraph",
    parts: [{ text: "Os dados poderão ser utilizados para:" }],
  },
  {
    type: "list",
    items: [
      [{ text: "criar e administrar Contas;" }],
      [{ text: "autenticar Usuários;" }],
      [{ text: "fornecer as funcionalidades contratadas;" }],
      [{ text: "conectar e sincronizar marketplaces;" }],
      [{ text: "processar informações de produtos, anúncios, vendas e pedidos;" }],
      [{ text: "calcular indicadores operacionais e financeiros;" }],
      [{ text: "gerar relatórios e análises;" }],
      [{ text: "fornecer alertas e notificações;" }],
      [{ text: "processar cobranças e administrar Planos;" }],
      [{ text: "prestar suporte;" }],
      [{ text: "identificar e corrigir falhas;" }],
      [{ text: "proteger Contas e a infraestrutura;" }],
      [{ text: "prevenir fraude e abuso;" }],
      [{ text: "monitorar desempenho e disponibilidade;" }],
      [{ text: "aprimorar a experiência e as funcionalidades;" }],
      [{ text: "cumprir obrigações legais e regulatórias;" }],
      [{ text: "exercer ou defender direitos em procedimentos administrativos, arbitrais ou judiciais." }],
    ],
  },
  {
    type: "paragraph",
    parts: [
      {
        text: "Quando uma finalidade depender de consentimento, o consentimento será solicitado de maneira adequada e poderá ser revogado nos termos da legislação aplicável.",
      },
    ],
  },
  { type: "heading", text: "5. Bases legais" },
  {
    type: "paragraph",
    parts: [
      {
        text: "O SUSE7 realizará o tratamento de dados pessoais utilizando bases legais compatíveis com cada finalidade.",
      },
    ],
  },
  {
    type: "paragraph",
    parts: [
      {
        text: "Dependendo da situação, o tratamento poderá ser necessário para:",
      },
    ],
  },
  {
    type: "list",
    items: [
      [{ text: "execução de contrato ou procedimentos relacionados à contratação;" }],
      [{ text: "cumprimento de obrigação legal ou regulatória;" }],
      [{ text: "exercício regular de direitos;" }],
      [{ text: "proteção contra fraude e riscos de segurança;" }],
      [{ text: "atendimento a interesses legítimos do SUSE7 ou de terceiros, respeitados os direitos dos titulares;" }],
      [{ text: "consentimento, quando essa for a base apropriada;" }],
      [{ text: "outras hipóteses autorizadas pela legislação aplicável." }],
    ],
  },
  {
    type: "paragraph",
    parts: [
      {
        text: "A existência de uma Conta não significa que todos os dados sejam tratados pela mesma base legal.",
      },
    ],
  },
  { type: "heading", text: "6. Dados de terceiros presentes na operação do Seller" },
  {
    type: "paragraph",
    parts: [
      {
        text: "A utilização de marketplaces poderá fazer com que o SUSE7 processe dados de terceiros vinculados à operação do Seller.",
      },
    ],
  },
  {
    type: "paragraph",
    parts: [
      {
        text: "Quando o Seller determinar as finalidades do tratamento desses dados e utilizar o SUSE7 como ferramenta de processamento, será responsabilidade do Seller garantir que sua coleta e utilização possuam fundamento jurídico adequado.",
      },
    ],
  },
  {
    type: "paragraph",
    parts: [
      {
        text: "O SUSE7 processará essas informações conforme as funcionalidades contratadas e as obrigações aplicáveis à sua posição no tratamento.",
      },
    ],
  },
  {
    type: "paragraph",
    parts: [
      {
        text: "O Usuário deverá evitar inserir na Plataforma informações pessoais desnecessárias ou incompatíveis com as funcionalidades oferecidas.",
      },
    ],
  },
  { type: "heading", text: "7. Compartilhamento de informações" },
  {
    type: "paragraph",
    parts: [
      {
        text: "O SUSE7 não comercializa dados pessoais como produto.",
      },
    ],
  },
  {
    type: "paragraph",
    parts: [
      {
        text: "Informações poderão ser compartilhadas quando necessário com categorias de terceiros como:",
      },
    ],
  },
  {
    type: "list",
    items: [
      [{ text: "provedores de infraestrutura em nuvem;" }],
      [{ text: "serviços de banco de dados e armazenamento;" }],
      [{ text: "serviços de autenticação e segurança;" }],
      [{ text: "serviços de monitoramento e observabilidade;" }],
      [{ text: "provedores de cobrança e pagamento;" }],
      [{ text: "serviços de atendimento e comunicação;" }],
      [{ text: "marketplaces e serviços conectados pelo próprio Usuário;" }],
      [{ text: "fornecedores técnicos necessários à operação da Plataforma;" }],
      [{ text: "contadores, auditores, consultores ou assessores profissionais, quando necessário;" }],
      [{ text: "autoridades públicas, mediante obrigação legal ou solicitação válida." }],
    ],
  },
  {
    type: "paragraph",
    parts: [
      {
        text: "Prestadores que processam dados em nome do SUSE7 deverão receber somente as informações necessárias à execução de suas funções e estarão sujeitos às obrigações aplicáveis de confidencialidade e proteção.",
      },
    ],
  },
  { type: "heading", text: "8. Transferência internacional de dados" },
  {
    type: "paragraph",
    parts: [
      {
        text: "Alguns fornecedores de tecnologia utilizados pelo SUSE7 poderão possuir infraestrutura ou realizar processamento fora do Brasil.",
      },
    ],
  },
  {
    type: "paragraph",
    parts: [
      {
        text: "Quando houver transferência internacional de dados pessoais, o SUSE7 adotará mecanismos compatíveis com a legislação brasileira e com as regulamentações aplicáveis da autoridade competente.",
      },
    ],
  },
  { type: "heading", text: "9. Cookies e tecnologias semelhantes" },
  {
    type: "paragraph",
    parts: [
      {
        text: "Os sites e sistemas do SUSE7 poderão utilizar cookies e tecnologias equivalentes para finalidades como:",
      },
    ],
  },
  {
    type: "list",
    items: [
      [{ text: "funcionamento da sessão;" }],
      [{ text: "autenticação;" }],
      [{ text: "segurança;" }],
      [{ text: "preferências;" }],
      [{ text: "medição de desempenho;" }],
      [{ text: "análise de utilização;" }],
      [{ text: "melhoria da experiência." }],
    ],
  },
  {
    type: "paragraph",
    parts: [
      {
        text: "Cookies estritamente necessários poderão ser utilizados para permitir o funcionamento adequado da Plataforma.",
      },
    ],
  },
  {
    type: "paragraph",
    parts: [
      {
        text: "Quando a legislação exigir consentimento para determinada categoria de cookie, serão disponibilizados mecanismos apropriados de escolha.",
      },
    ],
  },
  { type: "heading", text: "10. Segurança da Informação" },
  {
    type: "paragraph",
    parts: [
      {
        text: "O SUSE7 adota medidas técnicas e organizacionais destinadas a proteger as informações contra acesso não autorizado, perda, alteração, divulgação ou destruição indevida.",
      },
    ],
  },
  {
    type: "paragraph",
    parts: [{ text: "Essas medidas podem incluir, conforme aplicável:" }],
  },
  {
    type: "list",
    items: [
      [{ text: "controles de acesso;" }],
      [{ text: "segregação de ambientes;" }],
      [{ text: "proteção de credenciais;" }],
      [{ text: "criptografia em trânsito e, quando aplicável, em armazenamento;" }],
      [{ text: "registros de auditoria;" }],
      [{ text: "monitoramento;" }],
      [{ text: "mecanismos de backup e recuperação;" }],
      [{ text: "gestão de permissões;" }],
      [{ text: "práticas de desenvolvimento seguro;" }],
      [{ text: "atualização de componentes;" }],
      [{ text: "procedimentos de resposta a incidentes." }],
    ],
  },
  {
    type: "paragraph",
    parts: [
      {
        text: "Nenhum sistema conectado à internet pode oferecer garantia absoluta contra todos os riscos. Por isso, as medidas de segurança são continuamente avaliadas e aprimoradas de acordo com a evolução da Plataforma e das ameaças existentes.",
      },
    ],
  },
  { type: "heading", text: "11. Incidentes de segurança" },
  {
    type: "paragraph",
    parts: [
      {
        text: "Caso seja identificado incidente de segurança envolvendo dados pessoais, o SUSE7 realizará análise da natureza, extensão e possíveis consequências do evento.",
      },
    ],
  },
  {
    type: "paragraph",
    parts: [
      {
        text: "Quando houver obrigação legal de comunicação, serão adotadas as providências aplicáveis perante os titulares e autoridades competentes, observados os critérios e prazos previstos na legislação.",
      },
    ],
  },
  { type: "heading", text: "12. Retenção e exclusão" },
  {
    type: "paragraph",
    parts: [
      {
        text: "Os dados serão mantidos somente pelo período necessário para:",
      },
    ],
  },
  {
    type: "list",
    items: [
      [{ text: "fornecer os serviços;" }],
      [{ text: "cumprir as finalidades informadas;" }],
      [{ text: "atender obrigações legais ou regulatórias;" }],
      [{ text: "preservar registros necessários à segurança;" }],
      [{ text: "exercer direitos;" }],
      [{ text: "atender prazos prescricionais aplicáveis." }],
    ],
  },
  {
    type: "paragraph",
    parts: [
      {
        text: "Após o encerramento da Conta, determinadas informações poderão continuar armazenadas durante o período necessário ao cumprimento dessas obrigações.",
      },
    ],
  },
  {
    type: "paragraph",
    parts: [
      {
        text: "Dados mantidos exclusivamente em backups poderão permanecer por períodos adicionais até sua substituição ou eliminação dentro dos ciclos técnicos de retenção.",
      },
    ],
  },
  {
    type: "paragraph",
    parts: [
      {
        text: "Quando não houver fundamento para manutenção, os dados serão eliminados, anonimizados ou submetidos a outro procedimento permitido pela legislação.",
      },
    ],
  },
  { type: "heading", text: "13. Direitos dos titulares" },
  {
    type: "paragraph",
    parts: [
      {
        text: "Nos termos da legislação aplicável, titulares poderão solicitar, conforme cada caso:",
      },
    ],
  },
  {
    type: "list",
    items: [
      [{ text: "confirmação da existência de tratamento;" }],
      [{ text: "acesso aos dados;" }],
      [{ text: "correção de informações incompletas, inexatas ou desatualizadas;" }],
      [{ text: "informação sobre compartilhamentos;" }],
      [{ text: "anonimização, bloqueio ou eliminação quando legalmente cabíveis;" }],
      [{ text: "portabilidade, quando aplicável e regulamentada;" }],
      [{ text: "eliminação de dados tratados com base em consentimento, ressalvadas as hipóteses legais de conservação;" }],
      [{ text: "informação sobre a possibilidade de não fornecer consentimento e suas consequências;" }],
      [{ text: "revogação do consentimento;" }],
      [{ text: "revisão ou informações relacionadas a determinadas decisões automatizadas, quando aplicável;" }],
      [{ text: "oposição ao tratamento nas hipóteses previstas em lei." }],
    ],
  },
  {
    type: "paragraph",
    parts: [
      {
        text: "Para proteger o próprio titular, poderemos solicitar informações adicionais necessárias à confirmação de identidade antes de atender determinadas solicitações.",
      },
    ],
  },
  { type: "heading", text: "14. Como exercer seus direitos" },
  {
    type: "paragraph",
    parts: [
      {
        text: "Solicitações relacionadas à privacidade e proteção de dados poderão ser encaminhadas para:",
      },
    ],
  },
  {
    type: "paragraph",
    parts: [{ text: "contato@suse7.com.br", bold: true }],
  },
  {
    type: "paragraph",
    parts: [
      {
        text: "Antes da publicação definitiva desta Política, o SUSE7 deverá informar neste espaço o canal oficial responsável pelo atendimento dos titulares e, quando aplicável, as informações do Encarregado pelo Tratamento de Dados Pessoais.",
      },
    ],
  },
  { type: "heading", text: "15. Menores de idade" },
  {
    type: "paragraph",
    parts: [
      {
        text: "O SUSE7 é uma plataforma empresarial voltada a Sellers e não é destinada à contratação ou utilização autônoma por crianças.",
      },
    ],
  },
  {
    type: "paragraph",
    parts: [
      {
        text: "Caso seja identificada utilização indevida envolvendo dados de crianças ou adolescentes, serão adotadas as providências adequadas conforme a legislação aplicável.",
      },
    ],
  },
  { type: "heading", text: "16. Links e serviços externos" },
  {
    type: "paragraph",
    parts: [
      {
        text: "A Plataforma poderá conter links ou integrações com serviços de terceiros.",
      },
    ],
  },
  {
    type: "paragraph",
    parts: [
      {
        text: "As práticas de privacidade desses terceiros são regidas por suas próprias políticas e não são controladas pelo SUSE7.",
      },
    ],
  },
  {
    type: "paragraph",
    parts: [
      {
        text: "Recomendamos que o Usuário consulte os respectivos documentos antes de utilizar serviços externos.",
      },
    ],
  },
  { type: "heading", text: "17. Alterações desta Política" },
  {
    type: "paragraph",
    parts: [
      {
        text: "Esta Política poderá ser atualizada em razão de:",
      },
    ],
  },
  {
    type: "list",
    items: [
      [{ text: "evolução da Plataforma;" }],
      [{ text: "lançamento de funcionalidades;" }],
      [{ text: "alteração de fornecedores;" }],
      [{ text: "mudanças operacionais;" }],
      [{ text: "alterações legais ou regulatórias;" }],
      [{ text: "aprimoramento de práticas de segurança e privacidade." }],
    ],
  },
  {
    type: "paragraph",
    parts: [
      {
        text: "A versão vigente estará sempre disponível nesta página com sua respectiva data de atualização.",
      },
    ],
  },
  {
    type: "paragraph",
    parts: [
      {
        text: "Alterações materiais serão comunicadas aos Usuários por meios apropriados quando necessário.",
      },
    ],
  },
  { type: "heading", text: "18. Contato" },
  {
    type: "contact_details",
    intro: "Para dúvidas gerais sobre o SUSE7:",
    lines: [
      { label: "", value: "contato@suse7.com.br", href: "mailto:contato@suse7.com.br" },
      {
        label: "Para assuntos relacionados a privacidade e proteção de dados:",
        boldLabel: true,
      },
      { label: "contato@suse7.com.br", boldLabel: true },
      { label: "Controlador:", value: "[RAZÃO SOCIAL]" },
      { label: "CNPJ:", value: "[CNPJ]" },
      { label: "Endereço:", value: "[ENDEREÇO]" },
      { label: "Encarregado/DPO:", value: "[PREENCHER, SE APLICÁVEL]" },
    ],
  },
  {
    type: "footer",
    parts: [
      {
        text: "Privacidade e segurança são princípios considerados no desenvolvimento e na operação do SUSE7.",
      },
    ],
  },
];
