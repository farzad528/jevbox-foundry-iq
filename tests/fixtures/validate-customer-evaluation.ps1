param(
    [string]$Path = (Join-Path $PSScriptRoot 'customer-evaluation.json')
)

$ErrorActionPreference = 'Stop'
$pack = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json

if (-not $pack.syntheticOnly -or $pack.cloudUploadsApproved -or $pack.externalProcessingApproved) {
    throw 'Unsafe dataset consent flags'
}
if ($pack.liveVerificationStatus -ne 'not-run' -or @($pack.measurement.results).Count -ne 0) {
    throw 'An unexecuted fixture must not claim measured live results'
}
if ($pack.identityBinding.labelsAreEntraIdentities) {
    throw 'Fixture reader labels must not claim to be verified Entra identities'
}

$docs = @{}
foreach ($doc in $pack.documents) {
    if ($docs.ContainsKey($doc.id)) {
        throw 'Duplicate document ID'
    }
    $parsedId = [guid]::Empty
    if (-not [guid]::TryParse($doc.id, [ref]$parsedId)) {
        throw 'Invalid document ID'
    }
    if ($doc.fileName.EndsWith('.md') -and $null -ne $doc.pageNumbers) {
        throw 'Markdown fixture invented page numbers'
    }
    if ($doc.fileName.EndsWith('.pdf')) {
        $definedPages = @($doc.pages | ForEach-Object { $_.number })
        if (($definedPages -join ',') -ne (@($doc.pageNumbers) -join ',')) {
            throw 'PDF page expectations differ from the generation specification'
        }
        if ($doc.generationSpecIsParsedEvidence -or $doc.nativeParsingVerified -or $doc.geometryVerified) {
            throw 'PDF generation must not claim verified application parsing or geometry'
        }
    }
    foreach ($reader in $doc.readers) {
        if ($reader -notin $pack.identityBinding.readerLabels) {
            throw 'Unknown reader label'
        }
    }
    $docs[$doc.id] = $doc
}

$wikis = @{}
foreach ($wiki in $pack.wikiScenarios) {
    if (-not $wiki.id -or -not $wiki.title -or @($wiki.ownReaders).Count -eq 0) {
        throw 'Invalid wiki scenario'
    }
    if ($wikis.ContainsKey($wiki.id)) {
        throw 'Duplicate wiki scenario ID'
    }
    foreach ($reader in $wiki.ownReaders) {
        if ($reader -notin $pack.identityBinding.readerLabels) {
            throw 'Unknown wiki reader label'
        }
    }
    $wikis[$wiki.id] = $wiki
    if (@($wiki.rawDependencyIds).Count -eq 0 -or @($wiki.claims).Count -eq 0) {
        throw 'Wiki scenario must have source dependencies and claims'
    }
    $effective = @($wiki.ownReaders)
    foreach ($id in $wiki.rawDependencyIds) {
        if (-not $docs.ContainsKey($id)) {
            throw 'Unresolved wiki dependency'
        }
        $effective = @($effective | Where-Object { $_ -in $docs[$id].readers })
    }
    $actualReaders = (@($effective | Sort-Object) -join ',')
    $expectedReaders = (@($wiki.expectedEffectiveReaders | Sort-Object) -join ',')
    if ($actualReaders -ne $expectedReaders) {
        throw 'Wiki reader-intersection mismatch'
    }
    foreach ($claim in $wiki.claims) {
        if (-not $claim.text -or -not $claim.sourceId -or -not $claim.section -or -not $claim.supportingQuote) {
            throw 'Invalid sourced claim'
        }
        if ($claim.sourceId -notin $wiki.rawDependencyIds) {
            throw 'Claim not bound to a dependency'
        }
        $sourceText = $docs[$claim.sourceId].lines -join "`n"
        if (-not $sourceText.Contains('## ' + $claim.section)) {
            throw 'Claim section missing from original fixture'
        }
        if (-not $sourceText.Contains($claim.supportingQuote)) {
            throw 'Claim quote missing from original fixture'
        }
    }
}

$questionIds = @{}
foreach ($question in $pack.questions) {
    if (-not $question.id -or -not $question.question -or -not $question.expectedBehavior) {
        throw 'Invalid evaluation question'
    }
    if ($null -eq $question.readers -or @($question.readers).Count -eq 0) {
        throw 'Evaluation question requires a reader'
    }
    if ($question.expectedBehavior -notin @(
        'grounded-answer', 'explicitly-not-approved', 'abstain-without-protected-metadata',
        'abstain', 'grounded-answer-without-instruction-execution', 'grounded-answer-after-real-pdf-parsing'
    )) {
        throw 'Unknown evaluation behavior'
    }
    if ($questionIds.ContainsKey($question.id)) {
        throw 'Duplicate question ID'
    }
    $questionIds[$question.id] = $true
    foreach ($reader in $question.readers) {
        if ($reader -notin $pack.identityBinding.readerLabels) {
            throw 'Unknown question reader'
        }
    }
    foreach ($id in $question.expectedSourceIds) {
        if (-not $docs.ContainsKey($id)) {
            throw 'Unknown expected source'
        }
        foreach ($reader in $question.readers) {
            if ($reader -notin $docs[$id].readers) {
                throw 'Answer expectation discloses a denied source'
            }
        }
    }
    foreach ($id in $question.scopeDocumentIds) {
        if (-not $docs.ContainsKey($id)) {
            throw 'Unknown scoped source'
        }
        if ($null -ne $question.scopeDocumentIds -and @($question.scopeDocumentIds).Count -gt 0) {
            foreach ($id in $question.expectedSourceIds) {
                if ($id -notin $question.scopeDocumentIds) {
                    throw 'Answer expectation is outside the selected document scope'
                }
            }
        }
        $sourceSections = @(
            foreach ($id in $question.expectedSourceIds) {
                foreach ($line in $docs[$id].lines) {
                    if ($line.StartsWith('## ')) { $line.Substring(3) }
                }
                foreach ($page in $docs[$id].pages) {
                    foreach ($section in $page.sections) { $section.title }
                }
            }
        )
        foreach ($section in $question.expectedSections) {
            if ($section -notin $sourceSections) {
                throw 'Question section expectation is absent from its original sources'
            }
        }
    }
    foreach ($page in $question.expectedPages) {
        foreach ($id in $question.expectedSourceIds) {
            if ($page -notin $docs[$id].pageNumbers) {
                throw 'Citation page expectation is absent from the original PDF specification'
            }
        }
    }
}

$lifecycleIds = @{}
foreach ($scenario in $pack.lifecycleScenarios) {
    if (-not $scenario.id -or -not $scenario.operation -or -not $scenario.expected) {
        throw 'Invalid lifecycle scenario'
    }
    if ($lifecycleIds.ContainsKey($scenario.id)) {
        throw 'Duplicate lifecycle scenario ID'
    }
    $lifecycleIds[$scenario.id] = $true
    if ($scenario.wikiScenarioId -and -not $wikis.ContainsKey($scenario.wikiScenarioId)) {
        throw 'Lifecycle scenario references an unknown wiki'
    }
    foreach ($id in $scenario.scopeDocumentIds) {
        if (-not $docs.ContainsKey($id)) {
            throw 'Lifecycle scenario references an unknown scoped source'
        }
    }
    if ($null -ne $scenario.claimIndex) {
        $index = $scenario.claimIndex
        if (-not $scenario.wikiScenarioId -or ($index -isnot [int] -and $index -isnot [long]) -or
            $index -lt 0 -or $index -ge @($wikis[$scenario.wikiScenarioId].claims).Count) {
            throw 'Lifecycle scenario references an invalid claim'
        }
        $claim = $wikis[$scenario.wikiScenarioId].claims[$index]
        if ($scenario.expectedSourceId -ne $claim.sourceId -or $scenario.expectedSection -ne $claim.section) {
            throw 'Lifecycle citation expectation differs from claim-specific original support'
        }
    }
    if ($null -ne $scenario.expectedWikiEligible) {
        if (-not $scenario.wikiScenarioId -or @($scenario.scopeDocumentIds).Count -eq 0 -or
            $scenario.expectedWikiEligible -isnot [bool]) {
            throw 'Invalid lifecycle document-scope expectation'
        }
        $outside = @($wikis[$scenario.wikiScenarioId].rawDependencyIds |
            Where-Object { $_ -notin $scenario.scopeDocumentIds })
        if ($scenario.expectedWikiEligible -ne ($outside.Count -eq 0)) {
            throw 'Lifecycle scope expectation weakens the all-dependencies subset rule'
        }
    }
}

[pscustomobject]@{
    Documents = @($pack.documents).Count
    WikiScenarios = @($pack.wikiScenarios).Count
    Questions = @($pack.questions).Count
    LifecycleScenarios = @($pack.lifecycleScenarios).Count
    StructuralValidation = 'passed'
    LiveVerification = $pack.liveVerificationStatus
    Consent = 'no uploads or external processing'
} | ConvertTo-Json -Compress
